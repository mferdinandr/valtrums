import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Near } from "near-kit";
import { z } from "zod";
import { createJsonLogger, errorMessage, silentLogger, type Logger } from "../logger.js";
import { abortableSleep } from "../loop.js";
import { termsSchema, type ObservationTerms } from "../lifecycle-oracle/config.js";
import { VersionedLifecycleReadSource } from "../mcp/application-adapter.js";
import { ObservationCollector, type CollectRound, type SampleSource } from "./collector.js";
import { ObservationJournal } from "./journal.js";
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
  communities: Array<{ chain_id: string; token_address: string; reference_chain_id: string | null; reference_address: string | null }>;
}
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
  constructor(
    private readonly cfg: RunnerConfig,
    private readonly deps: {
      views: CollectorViews;
      journal: ObservationJournal;
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
    const now = BigInt((this.deps.now ?? Date.now)());
    const count = Number(await this.deps.views.count());
    let sampled = 0;
    for (let n = 1; n <= count; n++) {
      const id = String(n);
      if (this.finished.has(id)) continue;
      try {
        const battle = await this.deps.views.battle(id);
        if (!battle?.locked || !battle.observation_policy_hash) continue;
        const round = await this.deps.views.round(id);
        if (!round) continue;
        if (round.winner !== null) {
          this.finished.add(id);
          continue;
        }
        if (!round.start_ns || !round.end_ns) continue;
        const terms = this.cfg.terms.get(battle.observation_policy_hash);
        if (!terms) continue;
        const tolMs = BigInt(terms.boundary_tolerance_ns) / 1_000_000n;
        const startMs = BigInt(round.start_ns) / 1_000_000n;
        const endMs = BigInt(round.end_ns) / 1_000_000n;
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
          mappingVersion: this.cfg.mappingVersion, candidates, startNs: round.start_ns, endNs: round.end_ns, boundaryToleranceMs: Number(tolMs),
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
  const journal = await ObservationJournal.open(need("OBSERVATION_JOURNAL_DIR"));
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
    try { await runner.pass(stop); } catch (err) { log.error("observation collector pass failed", { error: errorMessage(err) }); }
    await abortableSleep(intervalMs, stop);
  }
}

const invokedDirectly = (() => { try { return fileURLToPath(import.meta.url) === process.argv[1]; } catch { return false; } })();
if (invokedDirectly) {
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort());
  runCollector(process.env, stop.signal).catch((err) => {
    console.error(JSON.stringify({ level: "fatal", msg: errorMessage(err) }));
    process.exitCode = 1;
  });
}
