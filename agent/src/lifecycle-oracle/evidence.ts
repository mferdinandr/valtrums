import { ObservationState, type StoredObservation } from "../observations/journal.js";
import { roundCoverage, type FrozenRound } from "../observations/query.js";
import { sha256Hex, canonicalJson, type Mode } from "../observations/schema.js";
import type { EvidenceKind, ObservationTerms } from "./config.js";

/**
 * Builds the `submit_lifecycle_observations` input for one round from PERSISTED observation evidence
 * only (issue #147). It never reads a provider, never fabricates or interpolates a sample, never
 * rescales a price and never picks a winner: when evidence is missing, gapped, of a disallowed kind
 * or for an unsupported mode, it returns a hold with a specific reason and the oracle submits nothing.
 * Times are the provider's observation times; a sample without one is never a boundary.
 */

export type Hold =
  | "mode_unsupported" | "mode_unqualified" | "no_allowed_evidence" | "coverage_incomplete" | "scale_mismatch" | "candidates_missing";

export type Build =
  | { ok: true; observations: CandidateObservationJson[]; evidenceIds: string[] }
  | { ok: false; hold: Hold; reason: string };

export interface CandidateObservationJson {
  community: number;
  observed_times_ns: string[];
  evidence_hash: string;
  data: { Price: { start: string; end: string } } | { Drawdown: { prices: string[] } };
}

const msToNs = (ms: string): string => (BigInt(ms) * 1_000_000n).toString();
const nsToMs = (ns: string): bigint => BigInt(ns) / 1_000_000n;
const tsOf = (s: StoredObservation): bigint => BigInt(s.observation.observedAtMs as string);

/** A copy of the state holding only effective samples whose source kind may resolve a round. */
export function allowedState(state: ObservationState, kinds: ReadonlySet<EvidenceKind>): ObservationState {
  const out = new ObservationState();
  for (const s of state.observations) {
    if (state.retracted.has(s.id) || !kinds.has(s.observation.source.kind)) continue;
    out.observations.push(s);
    out.byId.set(s.id, s);
  }
  out.head = state.head;
  return out;
}

function nearest(samples: StoredObservation[], target: bigint, tol: bigint): StoredObservation | null {
  let best: StoredObservation | null = null;
  let bestDist = 0n;
  for (const s of samples) {
    const t = tsOf(s);
    const d = t > target ? t - target : target - t;
    if (d > tol) continue;
    if (best === null || d < bestDist || (d === bestDist && s.seq < best.seq)) { best = s; bestDist = d; }
  }
  return best;
}

const evidenceHashOf = (round: FrozenRound, community: number, ids: string[]): string =>
  `obs:${sha256Hex(canonicalJson([round.namespace, round.battleId, round.roundId, community, ids]))}`;

export function buildSubmission(
  state: ObservationState,
  round: FrozenRound,
  terms: ObservationTerms,
  opts: { kinds: ReadonlySet<EvidenceKind>; qualified: ReadonlySet<Mode> },
): Build {
  if (round.mode !== "PriceGain" && round.mode !== "LowestDrawdown") {
    return { ok: false, hold: "mode_unsupported", reason: `${round.mode} needs exact supply or interval-trade evidence; refused live` };
  }
  if (!opts.qualified.has(round.mode)) return { ok: false, hold: "mode_unqualified", reason: `${round.mode} is not qualified for this deployment` };
  if (round.candidates.length === 0) return { ok: false, hold: "candidates_missing", reason: "the round has no candidates" };
  const view = allowedState(state, opts.kinds);
  const coverage = roundCoverage(view, round);
  const start = nsToMs(round.startNs);
  const end = nsToMs(round.endNs);
  const tol = BigInt(round.boundaryToleranceMs);
  const observations: CandidateObservationJson[] = [];
  const evidenceIds: string[] = [];
  const kindsText = [...opts.kinds].sort().join(", ");
  for (const community of [...round.candidates].sort((a, b) => a - b)) {
    const timed = view.observations
      .filter((s) => {
        const o = s.observation;
        return o.battleId === round.battleId && o.roundId === round.roundId && o.community === community && o.mode === round.mode &&
          o.policyHash === round.policyHash && o.observedAtMs !== null && o.inputs.kind === "price";
      })
      .sort((a, b) => (tsOf(a) < tsOf(b) ? -1 : tsOf(a) > tsOf(b) ? 1 : a.seq - b.seq));
    if (timed.length === 0) return { ok: false, hold: "no_allowed_evidence", reason: `community ${community}: no persisted ${kindsText} samples with a provider time` };
    for (const s of timed) {
      const i = s.observation.inputs;
      if (i.kind !== "price" || i.priceScale !== terms.price_decimals) {
        return { ok: false, hold: "scale_mismatch", reason: `community ${community}: a sample is not at the frozen price scale ${terms.price_decimals}; the oracle never rescales` };
      }
    }
    const cov = coverage.communities.find((c) => c.community === community);
    if (round.mode === "PriceGain") {
      const a = nearest(timed, start, tol);
      const b = nearest(timed, end, tol);
      if (!a || !b || a.id === b.id) return { ok: false, hold: "coverage_incomplete", reason: `community ${community}: ${!a ? "no start sample" : "no closing sample"} within the boundary tolerance` };
      const pa = a.observation.inputs as { price: string };
      const pb = b.observation.inputs as { price: string };
      observations.push({ community, observed_times_ns: [msToNs(a.observation.observedAtMs as string), msToNs(b.observation.observedAtMs as string)], evidence_hash: evidenceHashOf(round, community, [a.id, b.id]), data: { Price: { start: pa.price, end: pb.price } } });
      evidenceIds.push(a.id, b.id);
    } else {
      if (!cov?.complete) return { ok: false, hold: "coverage_incomplete", reason: `community ${community}: coverage is incomplete (${cov?.hasStart ? "" : "no start sample; "}${cov?.hasEnd ? "" : "no closing sample; "}${cov?.gaps.length ?? 0} gap(s))` };
      const series = timed.filter((s) => tsOf(s) >= start - tol && tsOf(s) <= end + tol);
      const distinct = new Set(series.map((s) => tsOf(s).toString()));
      if (series.length < 2 || distinct.size !== series.length) return { ok: false, hold: "coverage_incomplete", reason: `community ${community}: drawdown needs strictly increasing distinct sample times` };
      observations.push({ community, observed_times_ns: series.map((s) => msToNs(s.observation.observedAtMs as string)), evidence_hash: evidenceHashOf(round, community, series.map((s) => s.id)), data: { Drawdown: { prices: series.map((s) => (s.observation.inputs as { price: string }).price) } } });
      evidenceIds.push(...series.map((s) => s.id));
    }
  }
  return { ok: true, observations, evidenceIds };
}
