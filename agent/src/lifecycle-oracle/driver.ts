import { errorMessage, silentLogger, type Logger } from "../logger.js";
import type { NearTransport } from "../near-client.js";
import type { ObservationState } from "../observations/journal.js";
import type { FrozenRound } from "../observations/query.js";
import { buildSubmission } from "./evidence.js";
import type { OracleConfig } from "./config.js";
import type { BattleStatus, OracleStateDir, OracleStatus, Phase } from "./status.js";
import { MAX_STATUS_BATTLES, STATUS_SCHEMA } from "./status.js";

/**
 * Lifecycle oracle driver (OpenSpec arena-testnet-integrations, issue #147).
 *
 * Every decision is derived from AUTHORITATIVE records read on this pass: the battle, its round view and
 * the oracle identity in the contract's readiness view. Nothing is remembered between passes for safety,
 * so a restart, a lost response or a second execution re-reads the chain and does not repeat a write the
 * chain already shows as done. The oracle:
 *  - reveals terms (`start_lifecycle_rounds`) only when a storage deposit is explicitly configured,
 *  - opens a round only when none is open, with the current time as the start (the contract bounds it),
 *  - resolves only after the recorded end, only from persisted evidence of an allowed source kind,
 *    and otherwise HOLDS with a specific reason. It never picks a default winner, never uses a clock
 *    to resolve, never moves a recorded end and never substitutes synthetic inputs.
 * It holds no custody, player, relayer or operator authority, and it submits nothing in dry-run mode.
 */

export interface LifecycleViews {
  count(): Promise<string>;
  battle(id: string): Promise<{ locked: boolean; start_at_ms?: string | null; mode: "PriceGain" | "MarketCapGrowth" | "VolumeRatio" | "LowestDrawdown"; observation_policy_hash: string | null } | null>;
  round(id: string): Promise<{ round_id: string; candidates: number[]; start_ns: string | null; end_ns: string | null; winner: number | null } | null>;
  readiness(id: string): Promise<{ activated: boolean; paused: boolean; oracle: string | null }>;
}

/** One function-call action of a batch transaction. */
export interface BatchAction {
  method: string;
  args: object;
  gas: string;
  deposit?: string;
}

/**
 * Transaction sender. `batch`, when present, sends several function calls to one contract as ONE transaction; NEAR
 * applies its actions in order and atomically (a failing action reverts the others).
 */
export type OracleTx = Pick<NearTransport, "call"> & { batch?: (contractId: string, actions: BatchAction[]) => Promise<unknown> };

export interface OracleDeps {
  views: LifecycleViews;
  tx: OracleTx;
  loadEvidence: () => Promise<ObservationState>;
  state?: Pick<OracleStateDir, "write">;
  now?: () => number;
  log?: Logger;
  /**
   * After a rounds-start or open transaction, how often and how many times to look for the chain to show it
   * before taking the next step in the same visit (default 12 tries, 400 ms apart).
   */
  followUp?: { tries: number; delayMs: number };
}

export interface PassReport {
  checked: number;
  actions: number;
  holding: number;
  errors: number;
  passError: string | null;
}

const ONE_YOCTO = "1 yocto";
/** The arena's REOPEN_GRACE_NS (120 s) plus a margin so the contract never refuses the reopen as early. */
export const REOPEN_AFTER_NS = 130_000_000_000n;
const WRITE_GAS = "100 Tgas";
/** Newest battles scanned per pass, like the read service. Older locked battles need the indexer (#144). */
export const MAX_SCAN = 200;
const MAX_BACKOFF_PASSES = 8;
/** About how long an open-round transaction takes to land plus the page's next refresh. */
export const OPEN_LEAD_MS = 3_500;
/** `start_lifecycle_rounds` always creates round 1 (arena `Rounds::from_frozen_policy`). */
const FIRST_ROUND_ID = "1";
/** An unlocked battle whose start passed this long ago is re-read only every COLD_RECHECK_PASSES passes. */
const COLD_AFTER_MS = 5 * 60_000;
const COLD_RECHECK_PASSES = 10;

export class LifecycleOracle {
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly battles = new Map<string, BattleStatus>();
  private readonly finished = new Set<string>();
  private readonly failures = new Map<string, { count: number; skipUntilPass: number }>();
  /** Battles that never locked long after their start: skipped until this pass number. */
  private readonly coldUntilPass = new Map<string, number>();
  /** Battles whose combined start-and-open transaction failed: they use the two separate transactions instead. */
  private readonly batchFailed = new Set<string>();
  private passes = 0;
  private passError: string | null = null;

  constructor(private readonly cfg: OracleConfig, private readonly deps: OracleDeps) {
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? Date.now;
  }

  status(): OracleStatus {
    const rows = [...this.battles.values()].sort((a, b) => (BigInt(a.battleId) < BigInt(b.battleId) ? 1 : -1)).slice(0, MAX_STATUS_BATTLES);
    return {
      schema: STATUS_SCHEMA, updatedAtMs: String(this.now()), writesEnabled: this.cfg.writesEnabled, accountId: this.cfg.accountId,
      contract: this.cfg.arenaContractId, passes: this.passes, passError: this.passError,
      battles: Object.fromEntries(rows.map((r) => [r.battleId, r])),
    };
  }

  async pass(): Promise<PassReport> {
    this.passes++;
    const report: PassReport = { checked: 0, actions: 0, holding: 0, errors: 0, passError: null };
    let count: bigint;
    try {
      count = BigInt(await this.deps.views.count());
    } catch (err) {
      this.passError = `could not read the lifecycle battle count: ${errorMessage(err)}`;
      report.passError = this.passError;
      report.errors++;
      this.log.error("lifecycle oracle: cannot read battles", { error: this.passError });
      await this.persist();
      return report;
    }
    this.passError = null;
    let evidence: ObservationState | null = null;
    let evidenceError: string | null = null;
    const loadEvidence = async (): Promise<ObservationState> => {
      if (evidence) return evidence;
      if (evidenceError) throw new Error(evidenceError);
      try { evidence = await this.deps.loadEvidence(); return evidence; }
      catch (err) { evidenceError = `observation journal unavailable: ${errorMessage(err)}`; throw new Error(evidenceError); }
    };
    for (let id = count, scanned = 0; id >= 1n && scanned < MAX_SCAN; id--, scanned++) {
      const battleId = id.toString();
      if (this.finished.has(battleId)) continue;
      if ((this.coldUntilPass.get(battleId) ?? 0) > this.passes) continue;
      const failure = this.failures.get(battleId);
      if (failure && this.passes < failure.skipUntilPass) continue;
      try {
        const status = await this.one(battleId, loadEvidence);
        report.checked++;
        report.actions += status.actions.filter((a) => a.executed).length;
        if (["pending_evidence", "blocked", "needs_rounds_started"].includes(status.phase)) report.holding++;
        this.battles.set(battleId, status);
        this.failures.delete(battleId);
      } catch (err) {
        report.errors++;
        const n = (failure?.count ?? 0) + 1;
        // Bounded backoff per battle: a failing battle is retried later and never blocks the others.
        this.failures.set(battleId, { count: n, skipUntilPass: this.passes + 1 + Math.min(2 ** (n - 1), MAX_BACKOFF_PASSES) });
        this.battles.set(battleId, this.row(battleId, "error", null, [], [], errorMessage(err)));
        this.log.error("lifecycle oracle: battle failed", { battleId, error: errorMessage(err), attempts: n });
      }
    }
    await this.persist();
    this.log.info("lifecycle oracle pass", { ...report, writesEnabled: this.cfg.writesEnabled });
    return report;
  }

  private row(battleId: string, phase: Phase, roundId: string | null, reasons: string[], actions: BattleStatus["actions"], lastError: string | null = null): BattleStatus {
    return { battleId, phase, roundId, reasons, actions, lastError, updatedAtMs: String(this.now()) };
  }

  private async persist(): Promise<void> {
    try { await this.deps.state?.write(this.status()); }
    catch (err) { this.log.error("lifecycle oracle: cannot write status", { error: errorMessage(err) }); }
  }

  private async write(battleId: string, action: BattleStatus["actions"][number]["action"], method: string, args: object, deposit: string): Promise<BattleStatus["actions"][number]> {
    if (!this.cfg.writesEnabled) return { action, executed: false, outcome: "dry run: ORACLE_WRITES_ENABLED is not true" };
    try {
      await this.deps.tx.call(this.cfg.arenaContractId, method, args, WRITE_GAS, deposit);
      this.log.info("lifecycle oracle: sent", { battleId, method });
      return { action, executed: true, outcome: "sent" };
    } catch (err) {
      // The call may or may not have landed. The next pass re-reads the contract and decides again.
      this.log.error("lifecycle oracle: write failed or unconfirmed", { battleId, method, error: errorMessage(err) });
      return { action, executed: true, outcome: `failed or unconfirmed: ${errorMessage(err)}` };
    }
  }

  /** Sends several actions as one transaction; every action gets the transaction's outcome. */
  private async writeBatch(
    battleId: string,
    items: Array<{ action: BattleStatus["actions"][number]["action"]; method: string; args: object; deposit: string }>,
  ): Promise<BattleStatus["actions"]> {
    if (!this.cfg.writesEnabled) return items.map((i) => ({ action: i.action, executed: false, outcome: "dry run: ORACLE_WRITES_ENABLED is not true" }));
    try {
      await this.deps.tx.batch!(this.cfg.arenaContractId, items.map((i) => ({ method: i.method, args: i.args, gas: WRITE_GAS, deposit: i.deposit })));
      this.log.info("lifecycle oracle: sent", { battleId, method: items.map((i) => i.method).join("+") });
      return items.map((i) => ({ action: i.action, executed: true, outcome: "sent" }));
    } catch (err) {
      // Atomic on chain: either both actions applied or neither. The next pass re-reads the contract.
      this.log.error("lifecycle oracle: batch failed or unconfirmed", { battleId, error: errorMessage(err) });
      return items.map((i) => ({ action: i.action, executed: true, outcome: `failed or unconfirmed: ${errorMessage(err)}` }));
    }
  }

  /** Waits for the chain to show a round (or its window) after the oracle's own write; false if it never does. */
  private async waitForRound(battleId: string, needWindow: boolean): Promise<boolean> {
    const { tries, delayMs } = this.deps.followUp ?? { tries: 12, delayMs: 400 };
    for (let i = 0; i < tries; i++) {
      const round = await this.deps.views.round(battleId).catch(() => null);
      if (round && (!needWindow || (round.start_ns && round.end_ns))) return true;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return false;
  }

  /**
   * `depth` lets one visit take the next step right away (rounds started, then opened) instead of waiting
   * a whole pass for each. At most two follow-ups, and only after a write that reported itself sent.
   */
  private async one(battleId: string, loadEvidence: () => Promise<ObservationState>, depth = 0): Promise<BattleStatus> {
    const { views } = this.deps;
    const battle = await views.battle(battleId);
    if (!battle) return this.row(battleId, "not_locked", null, ["battle not found"], []);
    if (!battle.locked) {
      const startAt = battle.start_at_ms ? Number(battle.start_at_ms) : NaN;
      if (Number.isFinite(startAt) && this.now() - startAt > COLD_AFTER_MS) this.coldUntilPass.set(battleId, this.passes + COLD_RECHECK_PASSES);
      return this.row(battleId, "not_locked", null, ["battle is not locked yet"], []);
    }
    this.coldUntilPass.delete(battleId);
    const ready = await views.readiness(battleId);
    // Identity is validated before ANY write: wrong oracle, paused or not activated means hold.
    if (ready.oracle !== this.cfg.accountId) return this.row(battleId, "blocked", null, [`the arena's oracle is ${ready.oracle ?? "unset"}, not ${this.cfg.accountId}`], []);
    if (!ready.activated) return this.row(battleId, "blocked", null, ["lifecycle is not activated"], []);
    if (ready.paused) return this.row(battleId, "blocked", null, ["the arena is paused"], []);
    const hash = battle.observation_policy_hash;
    if (!hash) return this.row(battleId, "blocked", null, ["no frozen observation policy hash on the battle"], []);
    const round = await views.round(battleId);
    if (round?.winner !== null && round?.winner !== undefined) {
      this.finished.add(battleId);
      return this.row(battleId, "done", round.round_id, [`recorded winner: community ${round.winner}`], []);
    }
    const terms = this.cfg.terms.get(hash);
    if (!round) {
      if (!terms) return this.row(battleId, "blocked", null, ["no observation terms configured for the frozen policy hash"], []);
      if (!this.cfg.roundsStorageDepositYocto) {
        return this.row(battleId, "needs_rounds_started", null, ["rounds are not started; a funded caller must call start_lifecycle_rounds (the oracle spends no storage deposit unless ORACLE_ROUNDS_STORAGE_DEPOSIT_YOCTO is set)"], []);
      }
      // The config holds a bare yocto integer; near-kit refuses a unitless amount, so the unit is explicit here.
      const storage = `${this.cfg.roundsStorageDepositYocto} yocto`;
      if (this.deps.tx.batch && !this.batchFailed.has(battleId)) {
        // Reveal the terms and open round 1 in ONE transaction: one confirmation wait instead of two plus a poll. The
        // window starts when the transaction is expected to land, as for a separate open.
        const startNs = (BigInt(this.now() + OPEN_LEAD_MS) * 1_000_000n).toString();
        const actions = await this.writeBatch(battleId, [
          { action: "start_lifecycle_rounds", method: "start_lifecycle_rounds", args: { battle_id: battleId, terms }, deposit: storage },
          { action: "open_lifecycle_round", method: "open_lifecycle_round", args: { battle_id: battleId, round_id: FIRST_ROUND_ID, start_ns: startNs }, deposit: ONE_YOCTO },
        ]);
        if (actions[0]?.outcome === "sent") {
          if (depth < 2) await this.waitForRound(battleId, true);
          return this.row(battleId, "needs_open", FIRST_ROUND_ID, [`terms revealed and round ${FIRST_ROUND_ID} opened in one transaction`], actions);
        }
        // A failed or unknown combined send: this battle falls back to the two separate transactions from the next pass.
        if (actions[0]?.executed) this.batchFailed.add(battleId);
        return this.row(battleId, "needs_rounds_started", null, ["combined start and open not confirmed; the next pass re-reads the contract"], actions);
      }
      const a = await this.write(battleId, "start_lifecycle_rounds", "start_lifecycle_rounds", { battle_id: battleId, terms }, storage);
      if (a.outcome === "sent" && depth < 2 && (await this.waitForRound(battleId, false))) return this.one(battleId, loadEvidence, depth + 1);
      return this.row(battleId, "needs_rounds_started", null, ["terms reveal sent; waiting for the contract to show the rounds"], [a]);
    }
    if (!round.start_ns || !round.end_ns) {
      // Overtime and the first round both land here: a fresh window for exactly the contract's candidates.
      // The window starts when the transaction is expected to land, not when it is sent: the contract allows the
      // start within 300 s of block time, and a send-time start burned the first seconds of the round before the
      // chain (and the page) even showed it.
      const startNs = (BigInt(this.now() + OPEN_LEAD_MS) * 1_000_000n).toString();
      const a = await this.write(battleId, "open_lifecycle_round", "open_lifecycle_round", { battle_id: battleId, round_id: round.round_id, start_ns: startNs }, ONE_YOCTO);
      if (a.outcome === "sent" && depth < 2) await this.waitForRound(battleId, true);
      return this.row(battleId, "needs_open", round.round_id, [`opening round ${round.round_id} for candidates ${round.candidates.join(", ")}`], [a]);
    }
    const nowNs = BigInt(this.now()) * 1_000_000n;
    if (nowNs < BigInt(round.end_ns)) {
      return this.row(battleId, "window_open", round.round_id, [`round ${round.round_id} is collecting until its recorded end`], []);
    }
    // After the recorded end only evidence may resolve: the clock alone never picks a winner.
    if (!terms) return this.row(battleId, "blocked", round.round_id, ["no observation terms configured for the frozen policy hash"], []);
    let state: ObservationState;
    try { state = await loadEvidence(); }
    catch (err) { return this.row(battleId, "pending_evidence", round.round_id, [errorMessage(err)], []); }
    const frozen: FrozenRound = {
      namespace: this.cfg.scope, battleId, roundId: round.round_id, mode: battle.mode, policyHash: hash, candidates: round.candidates,
      startNs: round.start_ns, endNs: round.end_ns,
      boundaryToleranceMs: Number(BigInt(terms.boundary_tolerance_ns) / 1_000_000n), maxGapMs: Number(BigInt(terms.max_gap_ns) / 1_000_000n),
    };
    const built = buildSubmission(state, frozen, terms, { kinds: this.cfg.evidenceKinds, qualified: this.cfg.qualifiedModes });
    if (!built.ok) {
      // Evidence for this window never completed (for example a missed boundary sample) and the contract's reopen
      // grace has passed: abandon the window so a fresh one can open. Complete evidence is always submitted instead,
      // however late; this decides nothing and moves no funds.
      if (nowNs >= BigInt(round.end_ns) + REOPEN_AFTER_NS && (built.hold === "coverage_incomplete" || built.hold === "no_allowed_evidence")) {
        const a = await this.write(battleId, "reopen_lifecycle_round", "reopen_lifecycle_round", { battle_id: battleId, round_id: round.round_id }, ONE_YOCTO);
        return this.row(battleId, "needs_open", round.round_id, [`${built.hold}: ${built.reason}; the reopen grace passed, abandoning the window for a fresh one`], [a]);
      }
      return this.row(battleId, "pending_evidence", round.round_id, [`${built.hold}: ${built.reason}`], []);
    }
    const a = await this.write(battleId, "submit_lifecycle_observations", "submit_lifecycle_observations",
      { battle_id: battleId, round_id: round.round_id, observations: built.observations }, ONE_YOCTO);
    return this.row(battleId, "ready_to_resolve", round.round_id, [`submitted evidence for ${built.observations.length} candidate(s); the contract's recorded outcome decides`], [a]);
  }
}
