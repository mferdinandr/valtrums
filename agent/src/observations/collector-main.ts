import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Near } from "near-kit";
import { z } from "zod";
import { createJsonLogger, errorMessage, silentLogger, type Logger } from "../logger.js";
import { abortableSleep } from "../loop.js";
import { termsSchema, type ObservationTerms } from "../lifecycle-oracle/config.js";
import { VersionedLifecycleReadSource } from "../mcp/application-adapter.js";
import { ObservationCollector, type CollectRound, type SampleSource } from "./collector.js";
import { ObservationJournal, type JournalWriter } from "./journal.js";
import { journalStoreFromEnv } from "./journal-store.js";
import { appDb, closeAppDb } from "../app-state/app-db.js";
import { PgObservationJournal } from "../app-state/pg-observation-journal.js";
import { createPgLockSession } from "../app-state/pg-session.js";
import { OnchainSlot0Source } from "./onchain-source.js";
import { MODES, namespaceSchema, type Mode, type ObservationNamespace } from "./schema.js";

/**
 * Observation collector process (`pnpm -C agent observations:collect`). Every interval it reads the arena (views
 * only, no key), and for each locked battle whose recorded round window is open (within the boundary tolerance) it
 * samples the live source once and persists the samples to the journal the oracle reads. It holds no oracle,
 * custody, payout or player authority and never sends a transaction.
 */

interface BattleView {
  locked: boolean;
  mode: Mode;
  observation_policy_hash: string | null;
  cancelled?: boolean;
  communities: Array<{ chain_id: string; token_address: string; reference_chain_id: string | null; reference_address: string | null }>;
}
/** How often a battle that is not locked yet is read again (a lock is announced well before its rounds open). */
const UNLOCKED_RECHECK_MS = 15_000;
interface RoundView { round_id: string; candidates: number[]; start_ns: string | null; end_ns: string | null; winner: number | null }

export interface CollectorViews {
  count(): Promise<string>;
  battle(id: string): Promise<BattleView | null>;
  round(id: string): Promise<RoundView | null>;
}

export interface RunnerConfig {
  scope: ObservationNamespace;
  terms: ReadonlyMap<string, ObservationTerms>;
  mappingVersion: string;
  qualifiedModes: ReadonlySet<Mode>;
}

/** One pass over all battles. Returns how many rounds were sampled. Never throws for one battle's failure. */
export class CollectorRunner {
  private readonly finished = new Set<string>();
  private readonly sources = new Map<string, SampleSource>();
  /** A locked battle never changes its communities, mode or policy, so it is read once. */
  private readonly lockedBattles = new Map<string, BattleView>();
  private readonly unlockedCheckedAt = new Map<string, number>();
  private count: { value: number; atMs: number } | null = null;
  constructor(
    private readonly cfg: RunnerConfig,
    private readonly deps: {
      views: CollectorViews;
      journal: JournalWriter;
      sourceFor: (terms: ObservationTerms) => SampleSource;
      now?: () => number;
      log?: Logger;
    },
  ) {}

  private sourceOf(hash: string, terms: ObservationTerms): SampleSource {
    let s = this.sources.get(hash);
    if (!s) {
      s = this.deps.sourceFor(terms);
      this.sources.set(hash, s);
    }
    return s;
  }

  async pass(signal?: AbortSignal): Promise<number> {
    const log = this.deps.log ?? silentLogger;
    const nowMs = (this.deps.now ?? Date.now)();
    const now = BigInt(nowMs);
    // The battle count is re-read every 30 s; between reads only rounds are read, to spare the NEAR RPC.
    if (!this.count || nowMs - this.count.atMs >= 30_000) this.count = { value: Number(await this.deps.views.count()), atMs: nowMs };
    let sampled = 0;
    for (let n = 1; n <= this.count.value; n++) {
      const id = String(n);
      if (this.finished.has(id)) continue;
      try {
        let battle = this.lockedBattles.get(id) ?? null;
        if (!battle) {
          // An unlocked battle is re-read at most every UNLOCKED_RECHECK_MS, to spare the NEAR RPC.
          const checked = this.unlockedCheckedAt.get(id);
          if (checked !== undefined && nowMs - checked < UNLOCKED_RECHECK_MS) continue;
          battle = await this.deps.views.battle(id);
          this.unlockedCheckedAt.set(id, nowMs);
          if (battle?.cancelled === true) {
            this.finished.add(id); // a cancelled battle never plays a round
            continue;
          }
          if (!battle?.locked || !battle.observation_policy_hash) continue;
          this.lockedBattles.set(id, battle);
          this.unlockedCheckedAt.delete(id);
        }
        if (!battle.observation_policy_hash) continue;
        const round = await this.deps.views.round(id);
        if (!round) continue;
        if (round.winner !== null) {
          this.finished.add(id);
          this.lockedBattles.delete(id);
          continue;
        }
        const terms = this.cfg.terms.get(battle.observation_policy_hash);
        if (!terms) continue;
        const tolMs = BigInt(terms.boundary_tolerance_ns) / 1_000_000n;
        // No window yet (rounds just started, a tie, or a reopened round): sample anyway under a provisional window
        // starting now, so a sample already sits next to the start the oracle is about to record. The oracle only
        // uses samples within the tolerance of the recorded boundaries; the rest are never evidence.
        const provisional = !round.start_ns || !round.end_ns;
        const startNs = provisional ? (now * 1_000_000n).toString() : round.start_ns!;
        const endNs = provisional ? ((now + 30_000n) * 1_000_000n).toString() : round.end_ns!;
        const startMs = BigInt(startNs) / 1_000_000n;
        const endMs = BigInt(endNs) / 1_000_000n;
        if (now < startMs - tolMs || now > endMs + tolMs) continue;
        const candidates = round.candidates.flatMap((c) => {
          const community = battle.communities[c];
          if (!community) return [];
          const reference = community.reference_chain_id && community.reference_address
            ? { chainId: community.reference_chain_id, token: community.reference_address }
            : null;
          return [{ community: c, asset: { chainId: community.chain_id, token: community.token_address }, reference }];
        });
        const collectRound: CollectRound = {
          namespace: this.cfg.scope, battleId: id, roundId: round.round_id, mode: battle.mode, policyHash: battle.observation_policy_hash,
          mappingVersion: this.cfg.mappingVersion, candidates, startNs, endNs, boundaryToleranceMs: Number(tolMs),
        };
        const collector = new ObservationCollector(this.deps.journal, this.sourceOf(battle.observation_policy_hash, terms), {
          qualifiedModes: this.cfg.qualifiedModes, now: this.deps.now, log,
        });
        const report = await collector.collect(collectRound, signal);
        sampled++;
        if (report.degraded) log.warn("observation journal degraded", { battleId: id, roundId: round.round_id });
      } catch (err) {
        log.error("collector pass failed for a battle", { battleId: id, error: errorMessage(err) });
      }
    }
    return sampled;
  }
}

/** Defaults: the D5 WETH/USDG pool and WETH on Robinhood mainnet (docs/findings-and-decisions.md D5). */
const DEFAULT_WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const DEFAULT_USD_POOL = "0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca";

export async function runCollector(env: NodeJS.ProcessEnv, stop: AbortSignal): Promise<void> {
  const log = createJsonLogger();
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`missing required environment variable ${name}`);
    return v;
  };
  const network = (env.NEAR_NETWORK?.trim() || "testnet") as "testnet" | "mainnet";
  const arena = need("ARENA_CONTRACT_ID");
  const scope = namespaceSchema.parse(JSON.parse(need("ARENA_APPLICATION_OBSERVATION_SCOPE")));
  if (scope.arenaContract !== arena) throw new Error("ARENA_APPLICATION_OBSERVATION_SCOPE names another arena");
  const parsedTerms = z.record(z.string().min(1).max(128), termsSchema).parse(JSON.parse(readFileSync(need("ORACLE_TERMS_PATH"), "utf8")));
  const terms = new Map(Object.entries(parsedTerms));
  const qualified = new Set<Mode>();
  for (const raw of (env.OBSERVATION_QUALIFIED_MODES?.trim() || "PriceGain").split(",").map((m) => m.trim()).filter(Boolean)) {
    if (!(MODES as readonly string[]).includes(raw)) throw new Error(`OBSERVATION_QUALIFIED_MODES: unknown mode ${raw}`);
    qualified.add(raw as Mode);
  }
  const intervalMs = Number(env.COLLECTOR_INTERVAL_MS?.trim() || "1000");
  if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 10_000) throw new Error("COLLECTOR_INTERVAL_MS must be 250 to 10000");
  const rpcUrl = need("REFERENCE_RPC_URL");
  const near = new Near({ network, ...(env.NEAR_RPC_URL?.trim() ? { rpcUrl: env.NEAR_RPC_URL.trim() } : {}) });
  const source = new VersionedLifecycleReadSource(arena, (c, m, a) => near.view(c, m, a));
  const views: CollectorViews = {
    count: () => source.count(),
    battle: (id) => source.battle(id) as Promise<BattleView | null>,
    round: (id) => source.round(id) as Promise<RoundView | null>,
  };
  // The file journal in OBSERVATION_JOURNAL_DIR, or the database journal with OBSERVATION_JOURNAL_STORE=database.
  const store = journalStoreFromEnv(env);
  if (!store) throw new Error("missing required environment variable OBSERVATION_JOURNAL_DIR (or set OBSERVATION_JOURNAL_STORE=database)");
  const journal = store.kind === "file"
    ? await ObservationJournal.open(store.dir)
    : await PgObservationJournal.open({ db: appDb(env)!, session: await createPgLockSession(store.url), namespace: scope });
  log.info("observation journal opened", { store: store.kind });
  try {
  const runner = new CollectorRunner(
    { scope, terms, qualifiedModes: qualified, mappingVersion: env.COLLECTOR_MAPPING_VERSION?.trim() || "3" },
    {
      views, journal, log,
      sourceFor: (t) => new OnchainSlot0Source({
        rpcUrl, referenceChainId: "4663",
        wethAddress: env.COLLECTOR_WETH_ADDRESS?.trim() || DEFAULT_WETH,
        usdPool: env.COLLECTOR_USD_POOL?.trim() || DEFAULT_USD_POOL,
        eligiblePools: t.eligible_pools, priceScale: t.price_decimals,
      }),
    },
  );
  log.info("observation collector starting", { arena, network, intervalMs, termsConfigured: terms.size, qualifiedModes: [...qualified] });
  while (!stop.aborted) {
    const startedAt = Date.now();
    try { await runner.pass(stop); } catch (err) { log.error("observation collector pass failed", { error: errorMessage(err) }); }
    // Fixed rate: the RPC round trip counts toward the interval, so one pass starts every `intervalMs`.
    await abortableSleep(Math.max(0, intervalMs - (Date.now() - startedAt)), stop);
  }
  } finally {
    await journal.close();
    await closeAppDb();
    log.info("observation collector stopped; journal released");
  }
}

const invokedDirectly = (() => { try { return fileURLToPath(import.meta.url) === process.argv[1]; } catch { return false; } })();
if (invokedDirectly) {
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => stop.abort()); // not `once`: a repeated SIGTERM must not kill the process before the lock is released
  runCollector(process.env, stop.signal).catch((err) => {
    console.error(JSON.stringify({ level: "fatal", msg: errorMessage(err) }));
    process.exitCode = 1;
  });
}
