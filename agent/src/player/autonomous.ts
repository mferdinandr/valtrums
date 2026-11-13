import type { ActionReadSource } from "../mcp/actions/source.js";
import type { ModelProposer } from "./model.js";
import { PlayerState } from "./state.js";
import { isStrategyName, maxAmount, type Option, type StrategyName } from "./strategy.js";

/**
 * Autonomous player agent: an agent with its OWN NEAR account and its OWN token balance that plays battles by itself.
 * There is no grant and no approval step. The most it can lose is what its account holds, which is what the owner
 * chose to send it. It joins a battle (when it holds a joinable token the battle does not have yet), registers its
 * position, waits for the community's audit and backing approvals, and deposits, using the same arena calls as the
 * web app. Strategies carry no authority: the arena and the agent worker still audit and gate every community.
 */

const TGAS = 1_000_000_000_000n;
const JOIN_DEPOSIT_YOCTO = "20000000000000000000000";
const REGISTER_DEPOSIT_YOCTO = "10000000000000000000000";
const ONE_YOCTO = "1";
const BLOCK_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;
const APPROVAL_POLL_MS = 2_000;
/** After approvals did not arrive in time the agent looks again soon: they usually land a little later, before the start. */
const APPROVAL_RETRY_MS = 15_000;
/** How many polls (APPROVAL_POLL_MS apart) to wait for a freshly joined community to show in the battle view. */
const JOIN_VISIBLE_TRIES = 15;
/** After a model answer that is missing or invalid, do not ask again about those battles for this long. */
const MODEL_RETRY_MS = 2 * 60_000;
/** NEAR AI calls made so far, per state object (one per process) and agent account (the API key has a budget). */
const modelCalls = new WeakMap<PlayerState, Map<string, number[]>>();

export interface AutonomousAgentConfig {
  /** The agent's own NEAR account. It signs and funds everything itself. */
  account: string;
  /**
   * A hint about how to play, given to NEAR AI in the prompt (`crowd`: back the largest vault, `underdog`: the
   * smallest). The model decides; nothing here picks a community by rule.
   */
  style: StrategyName;
  /** Share of the balance of one token a single deposit may use, in basis points. */
  fractionBps: number;
  maxPerHour: number;
  /** Most NEAR AI calls per hour (the API key has a budget). */
  maxModelCallsPerHour: number;
  maxFailures: number;
  intervalSecs: number;
  scanBattles: number;
  /** Do not enter a battle that starts sooner than this: joining and the approvals take time. */
  minStartLeadMs: number;
  /** How long to wait for a community's audit and backing approvals before giving up on this battle for now. */
  approvalWaitMs: number;
  /** Name of the environment variable holding this agent's `ed25519:` key. */
  keyEnv: string;
  /**
   * Optional owner account that receives surplus tokens. Balances above `keepWhole` whole tokens (per token) are sent
   * there after each round. Off when absent. The owner account must already be registered on each token contract.
   */
  sweepTo?: string;
  /** Whole tokens (18 decimals) each token balance keeps as working capital. Required with `sweepTo`. */
  keepWhole?: number;
}

export interface FunctionCallRequest {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  /** Gas in gas units, decimal string. */
  gas: string;
  /** Attached deposit in yoctoNEAR, decimal string. */
  deposit: string;
}

export interface PlannedStep {
  label: "join" | "register" | "deposit";
  call: FunctionCallRequest;
}

export type AutoOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "no_option"; reason: string }
  | { kind: "dry_run"; battleId: number; community: number; amount: string; steps: PlannedStep[]; rationale: string }
  | { kind: "played"; battleId: number; community: number; amount: string; txHashes: string[]; rationale: string }
  | { kind: "error"; message: string };

export interface AutonomousDeps {
  source: Pick<ActionReadSource, "battle" | "position" | "tokenBalance">;
  /** Representations of the arena's joinable tokens. */
  joinable: () => Promise<string[]>;
  battleCount: () => Promise<number>;
  arena: string;
  /** Signs and sends one call with the agent's own key; returns the transaction hash. */
  sign: (agent: AutonomousAgentConfig, call: FunctionCallRequest) => Promise<string>;
  state: PlayerState;
  now: () => number;
  log: (event: Record<string, unknown>) => void;
  /** False (default) plans the steps and stops: nothing is signed, sent or waited for. */
  live: boolean;
  sleep?: (ms: number) => Promise<void>;
  /** NEAR AI Cloud client (`NEAR_AI_API_KEY`). Required: without it the agent does not play. */
  model?: ModelProposer;
}

const ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;
const KEY_ENV = /^[A-Z][A-Z0-9_]{2,63}$/;
const int = (v: unknown, def: number, min: number, max: number, what: string): number => {
  const n = v === undefined ? def : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new Error(`${what} must be an integer from ${min} to ${max}`);
  return n;
};

export function parseAutonomousAgents(raw: unknown): AutonomousAgentConfig[] {
  const list = (raw as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(list) || list.length === 0) throw new Error("autonomous agent config needs a non-empty `agents` list");
  const seen = new Set<string>();
  return list.map((a, i): AutonomousAgentConfig => {
    const x = (a ?? {}) as Record<string, unknown>;
    const at = `agents[${i}]`;
    const account = String(x.account ?? "");
    if (!ACCOUNT.test(account)) throw new Error(`${at}.account must be a NEAR account id`);
    if (seen.has(account)) throw new Error(`${at} repeats another agent`);
    seen.add(account);
    // `strategy` is the old name of `style`. Both are only a prompt hint for the model.
    const style = x.style ?? x.strategy ?? "crowd";
    if (!isStrategyName(style)) throw new Error(`${at}.style must be crowd or underdog`);
    if (typeof x.keyEnv !== "string" || !KEY_ENV.test(x.keyEnv)) throw new Error(`${at}.keyEnv must name an environment variable; keys never go in this file`);
    if (x.mode !== undefined) throw new Error(`${at}.mode is not supported: autonomous agents always decide with NEAR AI`);
    const sweepTo = x.sweepTo === undefined ? undefined : String(x.sweepTo);
    if (sweepTo !== undefined) {
      if (!ACCOUNT.test(sweepTo)) throw new Error(`${at}.sweepTo must be a NEAR account id`);
      if (sweepTo === account) throw new Error(`${at}.sweepTo must differ from the agent account`);
      // No default: sweeping must never silently take the agent's working capital.
      if (x.keepWhole === undefined) throw new Error(`${at}.keepWhole is required with sweepTo (whole tokens kept per token)`);
    }
    const keepWhole = x.keepWhole === undefined ? undefined : int(x.keepWhole, 0, 0, 1_000_000_000, `${at}.keepWhole`);
    return {
      account,
      style,
      keyEnv: x.keyEnv,
      ...(sweepTo !== undefined ? { sweepTo } : {}),
      ...(keepWhole !== undefined ? { keepWhole } : {}),
      fractionBps: int(x.fractionBps, 2_500, 1, 10_000, `${at}.fractionBps`),
      maxPerHour: int(x.maxPerHour, 6, 1, 120, `${at}.maxPerHour`),
      maxModelCallsPerHour: int(x.maxModelCallsPerHour, 12, 1, 600, `${at}.maxModelCallsPerHour`),
      maxFailures: int(x.maxFailures, 3, 1, 20, `${at}.maxFailures`),
      intervalSecs: int(x.intervalSecs, 15, 5, 3_600, `${at}.intervalSecs`),
      scanBattles: int(x.scanBattles, 10, 1, 200, `${at}.scanBattles`),
      minStartLeadMs: int(x.minStartLeadMs, 90_000, 10_000, 7 * 24 * 3_600_000, `${at}.minStartLeadMs`),
      approvalWaitMs: int(x.approvalWaitMs, 120_000, 10_000, 3_600_000, `${at}.approvalWaitMs`),
    };
  });
}

const gas = (tgas: bigint): string => (tgas * TGAS).toString();
/** One deposit per battle and per token: another token in the same battle is still open to this agent. */
const actedKey = (account: string, battleId: number, representation: string): string => `auto:${account}:${battleId}:${representation}`;

export interface Candidate {
  battleId: number;
  community: number;
  representation: string;
  /** True when the battle has no such community yet and the agent must join first. */
  needsJoin: boolean;
  balance: bigint;
  vault: bigint;
}

/** One decision round for one agent. Everything it does is read from the chain first, so a repeat never double-plays. */
export async function playOnce(agent: AutonomousAgentConfig, deps: AutonomousDeps): Promise<AutoOutcome> {
  const { state, now, log } = deps;
  const skip = (reason: string): AutoOutcome => {
    log({ event: "skipped", agent: agent.account, reason });
    return { kind: "skipped", reason };
  };
  if (state.failures >= agent.maxFailures) return skip("circuit_open");
  if (state.actedSince(now() - HOUR_MS) >= agent.maxPerHour) return skip("hourly_limit");

  // What the agent can spend: only tokens it actually holds.
  const joinable = await deps.joinable();
  const balances = new Map<string, bigint>();
  for (const rep of joinable) {
    const b = await deps.source.tokenBalance(rep, agent.account);
    if (b > 0n) balances.set(rep, b);
  }
  if (balances.size === 0) return skip("no_funds");

  const candidates: Candidate[] = [];
  // Why battles were passed over, so "nothing to play" can say which of the three it is (shown in the owner's log).
  const alreadyIn: number[] = [];
  const coolingOff: number[] = [];
  const startingSoon: number[] = [];
  const count = await deps.battleCount();
  for (let id = count, scanned = 0; id >= 1 && scanned < agent.scanBattles; id--, scanned++) {
    const battle = await deps.source.battle(id);
    if (!battle || battle.locked || battle.cancelled) continue;
    const startAt = battle.start_at_ms ? Number(battle.start_at_ms) : null;
    if (startAt === null || !Number.isFinite(startAt)) continue;
    if (startAt - now() < agent.minStartLeadMs) {
      startingSoon.push(id);
      continue;
    }
    const present = new Set(battle.communities.map((c) => c.representation));
    // Acted: a deposit was sent. Blocked: held back for a while (approvals late, a failed answer), nothing deposited yet.
    const acted = (rep: string) => state.has(actedKey(agent.account, id, rep));
    const done = (rep: string) => acted(rep) || state.isBlocked(actedKey(agent.account, id, rep), now());
    let held = false;
    let cooling = false;
    const skipDone = (rep: string): boolean => {
      if (!done(rep)) return false;
      if (acted(rep)) held = true;
      else cooling = true;
      return true;
    };
    for (const [community, c] of battle.communities.entries()) {
      const balance = balances.get(c.representation);
      if (balance === undefined) continue;
      if (skipDone(c.representation)) continue;
      candidates.push({ battleId: id, community, representation: c.representation, needsJoin: false, balance, vault: BigInt(c.vault) });
    }
    for (const [rep, balance] of balances) {
      if (present.has(rep)) continue;
      if (skipDone(rep)) continue;
      candidates.push({ battleId: id, community: battle.communities.length, representation: rep, needsJoin: true, balance, vault: 0n });
    }
    if (held) alreadyIn.push(id);
    if (cooling) coolingOff.push(id);
  }
  if (candidates.length === 0) {
    // The newest battle that explains the silence wins: "already in #36" beats "#37 starts too soon".
    const newest = (ids: number[]) => Math.max(...ids);
    const reason =
      alreadyIn.length > 0 ? `already_in:${newest(alreadyIn)}`
      : coolingOff.length > 0 ? `retry_later:${newest(coolingOff)}`
      : startingSoon.length > 0 ? `starting_soon:${newest(startingSoon)}`
      : "none_open";
    log({ event: "no_option", agent: agent.account, reason });
    return { kind: "no_option", reason };
  }

  // The model is offered the communities that already exist and whose token the agent holds; only when there is none
  // does it get the chance to join the newest battle with a token it holds.
  const existing = candidates.filter((c) => !c.needsJoin);
  const pool = existing.length > 0 ? existing : candidates.filter((c) => c.battleId === Math.max(...candidates.map((x) => x.battleId)));
  const options: Option[] = pool.map((c) => ({ battleId: c.battleId, community: c.community, vault: c.vault }));
  // One spending limit per option: the share of that option's own token balance.
  const limitOf = (c: Candidate): bigint => maxAmount(c.balance, c.balance, agent.fractionBps);

  // NEAR AI decides every play: where to back and how much. There is no rule-based path and no fallback: an
  // answer that is missing or fails validation means the agent sits this round out.
  if (!deps.model) return skip("model_not_configured");
  // The API key has a budget: cap the calls per hour, and after a failed answer leave those battles alone for a while.
  const byAccount = modelCalls.get(state) ?? new Map<string, number[]>();
  modelCalls.set(state, byAccount);
  const recent = (byAccount.get(agent.account) ?? []).filter((t) => t > now() - HOUR_MS);
  if (recent.length >= agent.maxModelCallsPerHour) return skip("model_call_limit");
  byAccount.set(agent.account, [...recent, now()]);
  const limits = pool.map(limitOf);
  const input = { strategy: agent.style, user: agent.account, options, maxAmount: limits.reduce((a, b) => (a > b ? a : b), 0n) };
  const asked = deps.model.proposeDetailed
    ? await deps.model.proposeDetailed(input)
    : await deps.model.propose(input).then((t) => (t === null ? null : { text: t, chatId: null }));
  const coolOff = () => {
    for (const c of pool) state.markBlocked(actedKey(agent.account, c.battleId, c.representation), now() + MODEL_RETRY_MS);
  };
  if (!asked) {
    coolOff();
    return skip("model_no_answer");
  }
  const verdict = parseModelChoice(asked.text, agent.account, pool, limitOf);
  if (!verdict) {
    log({ event: "model_answer_rejected", agent: agent.account, chatId: asked.chatId });
    coolOff();
    return skip("model_answer_invalid");
  }
  const picked = verdict.candidate;
  const amount = verdict.amount;
  const rationale = `NEAR AI: ${verdict.rationale}`;
  const chatId = asked.chatId;
  if (amount <= 0n) return skip("nothing_to_spend");

  const steps: PlannedStep[] = [];
  const position = picked.needsJoin ? null : await deps.source.position(picked.battleId, picked.community, agent.account);
  // The chain is the record of what was deposited: a battle where this account already holds a deposit is never
  // deposited into again, even when the local note of it was lost (a restart, a failed save, a second process).
  if (position && /^[0-9]+$/.test(position.amount) && BigInt(position.amount) > 0n) {
    const heldKey = actedKey(agent.account, picked.battleId, picked.representation);
    state.markActed(heldKey, { at: now(), actionId: heldKey, txHash: null, status: "sent" });
    return skip("already_deposited");
  }
  const registered = position ? position.registered : false;
  if (picked.needsJoin) {
    steps.push({
      label: "join",
      call: { receiverId: deps.arena, methodName: "join_lifecycle_battle", args: { battle_id: picked.battleId, representation: picked.representation }, gas: gas(30n), deposit: JOIN_DEPOSIT_YOCTO },
    });
  }
  // A join already registers the caller's position in the arena, so registering again would be refused
  // ("Cannot register position"). Only a community that already existed needs its own register step.
  if (!registered && !picked.needsJoin) {
    steps.push({
      label: "register",
      call: { receiverId: deps.arena, methodName: "register_lifecycle_position", args: { battle_id: picked.battleId, community: picked.community }, gas: gas(30n), deposit: REGISTER_DEPOSIT_YOCTO },
    });
  }
  steps.push({
    label: "deposit",
    call: {
      receiverId: picked.representation,
      methodName: "ft_transfer_call",
      args: { receiver_id: deps.arena, amount: amount.toString(), msg: JSON.stringify({ action: "lifecycle_deposit", battle_id: picked.battleId, community: picked.community }) },
      gas: gas(100n),
      deposit: ONE_YOCTO,
    },
  });
  const why = `${rationale} Spends ${amount} of ${picked.balance} held.${chatId ? ` NEAR AI chat ${chatId} (signature: GET /v1/signature/${chatId}).` : ""}`;

  if (!deps.live) {
    log({ event: "dry_run", agent: agent.account, battleId: picked.battleId, community: picked.community, amount: amount.toString(), steps: steps.map((s) => s.label), decidedBy: chatId ? "near-ai" : "rule", chatId });
    return { kind: "dry_run", battleId: picked.battleId, community: picked.community, amount: amount.toString(), steps, rationale: why };
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const hashes: string[] = [];
  const key = actedKey(agent.account, picked.battleId, picked.representation);
  try {
    let community = picked.community;
    for (const step of steps) {
      if (step.label === "deposit") {
        // The approvals come from the agent worker after the community exists; deposit only once both are in.
        const deadline = now() + agent.approvalWaitMs;
        for (;;) {
          const battle = await deps.source.battle(picked.battleId);
          if (!battle || battle.locked || battle.cancelled) return skip("battle_closed");
          const c = battle.communities[community];
          const approved = c && c.audit_evidence_hash && c.backing_evidence_hash && c.audit_expires_at_ms && BigInt(c.audit_expires_at_ms) > BigInt(now());
          if (approved) break;
          if (now() >= deadline) {
            state.markBlocked(key, now() + APPROVAL_RETRY_MS);
            return skip("approvals_pending");
          }
          await sleep(APPROVAL_POLL_MS);
        }
      }
      // Hold this battle back for a while before a deposit leaves: if the transaction goes out but its answer is lost,
      // the next round must not send it again. After the hold the chain read above decides.
      if (step.label === "deposit") state.markBlocked(key, now() + BLOCK_MS);
      const hash = await deps.sign(agent, step.call);
      hashes.push(hash);
      log({ event: "sent", agent: agent.account, step: step.label, battleId: picked.battleId, txHash: hash });
      if (step.label === "join") {
        // The new community's index comes from the arena, not from the guess made before joining.
        // A view can lag the transaction by a few seconds, so look for the community for a while before giving up.
        let at = -1;
        for (let i = 0; i < JOIN_VISIBLE_TRIES && at < 0; i++) {
          const battle = await deps.source.battle(picked.battleId);
          at = battle?.communities.findIndex((c) => c.representation === picked.representation) ?? -1;
          if (at < 0) await sleep(APPROVAL_POLL_MS);
        }
        if (at < 0) throw new Error("the community did not appear after joining");
        community = at;
        const reg = steps.find((s) => s.label === "register");
        if (reg) reg.call.args = { battle_id: picked.battleId, community };
        const dep = steps.find((s) => s.label === "deposit");
        if (dep) dep.call.args = { ...dep.call.args, msg: JSON.stringify({ action: "lifecycle_deposit", battle_id: picked.battleId, community }) };
      }
    }
    // Remember the deposit before anything else can fail: a transaction that left must never be sent again.
    state.markActed(key, { at: now(), actionId: key, txHash: hashes.at(-1) ?? null, status: "sent" });
    log({ event: "played", agent: agent.account, battleId: picked.battleId, community, amount: amount.toString(), decidedBy: chatId ? "near-ai" : "rule", chatId });
    return { kind: "played", battleId: picked.battleId, community, amount: amount.toString(), txHashes: hashes, rationale: why };
  } catch (err) {
    const n = state.recordFailure();
    const message = err instanceof Error ? err.message : String(err);
    log({ event: "error", agent: agent.account, failures: n, message });
    return { kind: "error", message };
  }
}

export interface SweepDeps {
  /** Representations of the arena's joinable tokens. */
  joinable: () => Promise<string[]>;
  balance: (token: string, account: string) => Promise<bigint>;
  /** True when `account` is registered (has a storage balance) on the token contract. */
  registered: (token: string, account: string) => Promise<boolean>;
  sign: (agent: AutonomousAgentConfig, call: FunctionCallRequest) => Promise<string>;
  log: (event: Record<string, unknown>) => void;
  live: boolean;
}

export interface SweepResult {
  token: string;
  amount: string;
  txHash: string | null;
  status: "sent" | "planned" | "owner_not_registered";
}

/**
 * Sends each token balance above `keepWhole` whole tokens to the owner (`sweepTo`). It moves only what the agent holds
 * in its own account, never anything the arena holds. Nothing happens without `sweepTo`, and a token whose contract
 * has no storage registration for the owner is skipped (the transfer would be refused).
 */
export async function sweepOnce(agent: AutonomousAgentConfig, deps: SweepDeps): Promise<SweepResult[]> {
  if (!agent.sweepTo || agent.keepWhole === undefined) return [];
  const keep = BigInt(agent.keepWhole) * 10n ** 18n;
  const out: SweepResult[] = [];
  for (const token of await deps.joinable()) {
    const balance = await deps.balance(token, agent.account);
    if (balance <= keep) continue;
    const amount = balance - keep;
    if (!(await deps.registered(token, agent.sweepTo))) {
      deps.log({ event: "sweep_skipped", agent: agent.account, token, reason: "owner_not_registered" });
      out.push({ token, amount: amount.toString(), txHash: null, status: "owner_not_registered" });
      continue;
    }
    const call: FunctionCallRequest = {
      receiverId: token,
      methodName: "ft_transfer",
      args: { receiver_id: agent.sweepTo, amount: amount.toString() },
      gas: gas(30n),
      deposit: ONE_YOCTO,
    };
    if (!deps.live) {
      deps.log({ event: "sweep_planned", agent: agent.account, token, amount: amount.toString(), to: agent.sweepTo });
      out.push({ token, amount: amount.toString(), txHash: null, status: "planned" });
      continue;
    }
    const txHash = await deps.sign(agent, call);
    deps.log({ event: "swept", agent: agent.account, token, amount: amount.toString(), to: agent.sweepTo, txHash });
    out.push({ token, amount: amount.toString(), txHash, status: "sent" });
  }
  return out;
}

const MODEL_KEYS = new Set(["action", "user", "battleId", "community", "amount", "rationale"]);

/**
 * Validates a NEAR AI answer like any untrusted input: exactly one JSON object (optionally in one ```json fence) with
 * only the known fields, for this agent, naming one of the options it was offered, with an amount that is a positive
 * integer within THAT option's limit. Anything else returns null and the agent skips the round.
 */
export function parseModelChoice(
  text: string,
  account: string,
  pool: readonly Candidate[],
  limitOf: (c: Candidate) => bigint,
): { candidate: Candidate; amount: bigint; rationale: string } | null {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
  let value: unknown;
  try {
    value = JSON.parse(fenced ? fenced[1]! : text.trim());
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (Object.keys(o).some((k) => !MODEL_KEYS.has(k))) return null;
  if (o.action !== "deposit" || o.user !== account) return null;
  if (!Number.isInteger(o.battleId) || !Number.isInteger(o.community)) return null;
  const candidate = pool.find((c) => c.battleId === o.battleId && c.community === o.community);
  if (!candidate) return null;
  if (typeof o.amount !== "string" || !/^[1-9][0-9]{0,38}$/.test(o.amount)) return null;
  const amount = BigInt(o.amount);
  if (amount > limitOf(candidate)) return null;
  const rationale = typeof o.rationale === "string" ? o.rationale.slice(0, 200).replace(/[\r\n]+/g, " ") : "";
  return { candidate, amount, rationale };
}
