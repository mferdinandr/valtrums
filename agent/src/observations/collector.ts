import { errorMessage, silentLogger, type Logger } from "../logger.js";
import { ObservationConflictError, ObservationValidationError, type JournalWriter } from "./journal.js";
import { observationSchema, type Mode, type ObservationNamespace } from "./schema.js";

/**
 * Observation collector (OpenSpec arena-market-observations, issue #146). It turns a sample source's
 * raw output into observation evidence and persists it BEFORE anything can publish or submit it.
 *
 * Identity is never taken from the source: the frozen round (contract view plus the protocol
 * reference registry) says which asset and optional mainnet reference each community has, and the
 * collector stamps that identity on every sample. A source can only supply a price, its own time and
 * its evidence id per community. There is no ticker lookup and no default NEAR reader here: a
 * deployment must configure its source explicitly, and a live source cannot be enabled until the
 * provider qualification (#147 / testnet owner) says so. The collector holds no oracle, custody,
 * payout or player authority and never submits anything.
 */

export interface AssetIdentity {
  chainId: string;
  token: string;
}

/** Frozen facts for one round. They come from the contract and registry, never from the sample source. */
export interface CollectRound {
  namespace: ObservationNamespace;
  battleId: string;
  roundId: string;
  mode: Mode;
  policyHash: string;
  mappingVersion: string;
  candidates: Array<{ community: number; asset: AssetIdentity; reference: AssetIdentity | null }>;
  /** Recorded window (ns, decimal strings). Retry time never shifts it. */
  startNs: string;
  endNs: string;
  boundaryToleranceMs: number;
}

export interface RawSample {
  community: number;
  /** Positive integer price in `priceScale` fixed point. Missing data is omitted, never zero. */
  price: string;
  priceScale: number;
  /** Provider observation time (ms) or null when the provider gives none. */
  observedAtMs: string | null;
  /** Provider-side identity of this sample (trade id, block and log, response id). Required for dedup. */
  evidenceHash: string;
  pool: string | null;
  quote: string;
}

export interface SampleSource {
  readonly name: string;
  /** Fixture and recorded sources can never be labeled live: the kind is stamped into each sample. */
  readonly kind: "fixture" | "recorded" | "live";
  sample(round: CollectRound, signal?: AbortSignal): Promise<RawSample[]>;
}

export interface CollectReport {
  created: number;
  duplicates: number;
  rejected: Array<{ community: number | null; reason: string }>;
  /** True when the journal stopped accepting evidence (capacity, conflict): the round is degraded. */
  degraded: boolean;
}

const SUPPORTED_MODES: readonly Mode[] = ["PriceGain", "LowestDrawdown"];

/** Chain-aware identity check. Only EVM-style 20-byte addresses are supported; others are refused, not guessed. */
export function normalizeIdentity(id: AssetIdentity): AssetIdentity {
  if (!/^(0|[1-9][0-9]*)$/.test(id.chainId)) throw new Error("chain id must be a decimal string");
  if (!/^0x[0-9a-fA-F]{40}$/.test(id.token)) throw new Error(`chain ${id.chainId}: only 20-byte hex token addresses are supported`);
  return { chainId: id.chainId, token: id.token.toLowerCase() };
}

export class ObservationCollector {
  private readonly log: Logger;
  constructor(
    private readonly journal: JournalWriter,
    private readonly source: SampleSource,
    private readonly opts: { now?: () => number; qualifiedModes: ReadonlySet<Mode>; log?: Logger },
  ) {
    this.log = opts.log ?? silentLogger;
  }

  /** One collection pass for one round. Never throws for a bad sample; a journal failure marks the pass degraded. */
  async collect(round: CollectRound, signal?: AbortSignal): Promise<CollectReport> {
    const report: CollectReport = { created: 0, duplicates: 0, rejected: [], degraded: false };
    if (!SUPPORTED_MODES.includes(round.mode)) {
      report.rejected.push({ community: null, reason: `${round.mode} needs exact supply or interval-trade evidence this collector does not provide` });
      return report;
    }
    if (!this.opts.qualifiedModes.has(round.mode)) {
      report.rejected.push({ community: null, reason: `${round.mode} is not qualified for this deployment` });
      return report;
    }
    // Bind identity from the frozen round, once, before any source output is looked at.
    const identities = new Map<number, { asset: AssetIdentity; reference: AssetIdentity | null }>();
    try {
      for (const c of round.candidates) identities.set(c.community, { asset: normalizeIdentity(c.asset), reference: c.reference ? normalizeIdentity(c.reference) : null });
    } catch (err) {
      report.rejected.push({ community: null, reason: `frozen round identity rejected: ${errorMessage(err)}` });
      return report;
    }
    const start = BigInt(round.startNs) / 1_000_000n;
    const end = BigInt(round.endNs) / 1_000_000n;
    const tol = BigInt(round.boundaryToleranceMs);
    let raw: RawSample[];
    try {
      raw = await this.source.sample(round, signal);
    } catch (err) {
      // A source outage is a gap in the evidence, never a reason to invent or reuse a sample.
      report.rejected.push({ community: null, reason: `source unavailable: ${errorMessage(err)}` });
      return report;
    }
    const acquiredAtMs = String((this.opts.now ?? Date.now)());
    for (const s of raw) {
      const identity = identities.get(s.community);
      if (!identity) {
        report.rejected.push({ community: s.community, reason: "community is not a candidate of this round" });
        continue;
      }
      if (s.observedAtMs !== null) {
        const t = BigInt(s.observedAtMs);
        if (t < start - tol || t > end + tol) {
          report.rejected.push({ community: s.community, reason: "sample is outside the recorded window" });
          continue;
        }
      }
      const candidate = {
        schema: "market-observation-v1",
        namespace: round.namespace, battleId: round.battleId, roundId: round.roundId, community: s.community,
        mode: round.mode, policyHash: round.policyHash, mappingVersion: round.mappingVersion,
        asset: identity.asset, reference: identity.reference,
        source: { name: this.source.name, kind: this.source.kind, pool: s.pool, quote: s.quote },
        inputs: { kind: "price", price: s.price, priceScale: s.priceScale },
        evidenceHash: s.evidenceHash, observedAtMs: s.observedAtMs, acquiredAtMs,
      };
      const parsed = observationSchema.safeParse(candidate);
      if (!parsed.success) {
        report.rejected.push({ community: s.community, reason: `invalid sample: ${parsed.error.issues[0]?.message ?? "schema"}` });
        continue;
      }
      try {
        const result = await this.journal.append(parsed.data);
        if (result.status === "created") report.created++;
        else report.duplicates++;
      } catch (err) {
        if (err instanceof ObservationConflictError) report.rejected.push({ community: s.community, reason: "conflicting evidence for the same source slot" });
        else if (err instanceof ObservationValidationError) report.rejected.push({ community: s.community, reason: err.message });
        else {
          // Capacity or disk failure: stop, report, and let the operator recover. Nothing is dropped silently.
          report.degraded = true;
          report.rejected.push({ community: s.community, reason: `journal write failed: ${errorMessage(err)}` });
          break;
        }
        report.degraded = report.degraded || err instanceof ObservationConflictError;
      }
    }
    this.log.info("observation collection pass", { battleId: round.battleId, roundId: round.roundId, created: report.created, duplicates: report.duplicates, rejected: report.rejected.length, degraded: report.degraded });
    return report;
  }
}

/** Replays a fixed list of samples: a recorded or fixture source. It is labeled as such inside every sample. */
export class RecordedSampleSource implements SampleSource {
  constructor(readonly name: string, readonly kind: "fixture" | "recorded", private readonly samples: readonly RawSample[]) {}
  async sample(): Promise<RawSample[]> {
    return [...this.samples];
  }
}

/** The live adapter is intentionally absent until provider qualification exists; asking for it fails with the reason. */
export function liveSourceUnavailable(): never {
  throw new Error("live observation source is disabled: no provider qualification record (#147) approves a source, cadence and coverage yet");
}
