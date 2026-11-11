import { MODES, namespaceKey, type Mode, type Observation, type ObservationNamespace } from "./schema.js";
import type { ObservationState, StoredObservation, Watermark } from "./journal.js";

/**
 * Bounded server-side observation reads and the coverage / provisional-score projection
 * (OpenSpec arena-market-observations, issue #146). Everything here is pure over an
 * {@link ObservationState}: it never touches a provider, a contract or the disk.
 *
 * Scores are exact signed rationals (BigInt). They are PROVISIONAL display values: they never pick a
 * winner, open an overtime or move funds. The contract's recorded outcome is read separately and is
 * the only authority. Missing evidence is a gap or `incomplete`, never zero and never interpolated.
 */

export const MAX_PAGE = 200;
export const DEFAULT_PAGE = 50;

export interface ObservationQuery {
  namespace: ObservationNamespace;
  battleId: string;
  roundId?: string;
  community?: number;
  /** Exclusive journal sequence cursor (the `nextCursor` of the previous page). */
  afterSeq?: number;
  limit?: number;
  /** Inclusive provider-time window; records with unknown observation time are excluded by a window. */
  observedFromMs?: string;
  observedToMs?: string;
}

export interface ObservationPage {
  items: Array<{ seq: number; id: string; observation: Observation }>;
  nextCursor: string | null;
  truncated: boolean;
  watermark: Watermark;
  /** Changes when a retraction invalidates earlier evidence: reload instead of appending a delta. */
  revision: number;
  retractedSinceCursor: string[];
}

export class ObservationQueryError extends Error {
  constructor(reason: string) {
    super(`invalid observation query: ${reason}`);
    this.name = "ObservationQueryError";
  }
}

const DEC = /^(0|[1-9][0-9]*)$/;

export function queryObservations(state: ObservationState, q: ObservationQuery): ObservationPage {
  if (!DEC.test(q.battleId) || (q.roundId !== undefined && !DEC.test(q.roundId))) throw new ObservationQueryError("ids must be decimal strings");
  if (q.community !== undefined && (!Number.isInteger(q.community) || q.community < 0 || q.community > 15)) throw new ObservationQueryError("community out of range");
  const limit = q.limit ?? DEFAULT_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new ObservationQueryError(`limit must be 1..${MAX_PAGE}`);
  const after = q.afterSeq ?? 0;
  if (!Number.isInteger(after) || after < 0) throw new ObservationQueryError("cursor must be a non-negative integer");
  for (const t of [q.observedFromMs, q.observedToMs]) if (t !== undefined && !DEC.test(t)) throw new ObservationQueryError("time bounds must be decimal strings");
  const ns = namespaceKey(q.namespace);
  const matches = (s: StoredObservation): boolean => {
    const o = s.observation;
    if (s.seq <= after || state.retracted.has(s.id)) return false;
    if (namespaceKey(o.namespace) !== ns || o.battleId !== q.battleId) return false;
    if (q.roundId !== undefined && o.roundId !== q.roundId) return false;
    if (q.community !== undefined && o.community !== q.community) return false;
    if (q.observedFromMs !== undefined || q.observedToMs !== undefined) {
      if (o.observedAtMs === null) return false;
      const t = BigInt(o.observedAtMs);
      if (q.observedFromMs !== undefined && t < BigInt(q.observedFromMs)) return false;
      if (q.observedToMs !== undefined && t > BigInt(q.observedToMs)) return false;
    }
    return true;
  };
  const items: ObservationPage["items"] = [];
  let truncated = false;
  for (const s of state.observations) {
    if (!matches(s)) continue;
    if (items.length === limit) {
      truncated = true;
      break;
    }
    items.push({ seq: s.seq, id: s.id, observation: s.observation });
  }
  const last = items.at(-1);
  // Retractions after the cursor tell a delta poller which earlier items it must drop.
  const retractedSinceCursor = [...state.retracted.values()]
    .filter((r) => r.seq > after && namespaceKey(state.byId.get(r.observationId)!.observation.namespace) === ns && state.byId.get(r.observationId)!.observation.battleId === q.battleId)
    .map((r) => r.observationId);
  return {
    items,
    nextCursor: truncated && last ? String(last.seq) : null,
    truncated,
    watermark: state.head,
    revision: state.retracted.size,
    retractedSinceCursor,
  };
}

/** Frozen round facts that come from the contract/indexer, never from the observations themselves. */
export interface FrozenRound {
  namespace: ObservationNamespace;
  battleId: string;
  roundId: string;
  mode: Mode;
  policyHash: string;
  candidates: number[];
  /** Recorded window in nanoseconds (decimal strings), exactly as the contract stores it. */
  startNs: string;
  endNs: string;
  /** Approved boundary tolerance and maximum sample gap, in milliseconds. */
  boundaryToleranceMs: number;
  maxGapMs: number;
}

export interface Gap {
  fromMs: string;
  toMs: string;
}

export interface CommunityCoverage {
  community: number;
  samples: number;
  /** Samples without a provider observation time: counted, but never used for boundaries or gaps. */
  unknownTime: number;
  hasStart: boolean;
  hasEnd: boolean;
  gaps: Gap[];
  firstObservedAtMs: string | null;
  lastObservedAtMs: string | null;
  complete: boolean;
}

export interface RoundCoverage {
  watermark: Watermark;
  revision: number;
  /** Samples in this round that belong to another mode, policy or unlisted community. */
  foreign: number;
  communities: CommunityCoverage[];
}

const nsToMs = (ns: string): bigint => BigInt(ns) / 1_000_000n;

function roundSamples(state: ObservationState, round: FrozenRound): { mine: StoredObservation[]; foreign: number } {
  const ns = namespaceKey(round.namespace);
  const mine: StoredObservation[] = [];
  let foreign = 0;
  for (const s of state.observations) {
    const o = s.observation;
    if (state.retracted.has(s.id) || namespaceKey(o.namespace) !== ns || o.battleId !== round.battleId || o.roundId !== round.roundId) continue;
    if (o.mode !== round.mode || o.policyHash !== round.policyHash || !round.candidates.includes(o.community)) {
      foreign++;
      continue;
    }
    mine.push(s);
  }
  return { mine, foreign };
}

function coverageOf(community: number, samples: StoredObservation[], round: FrozenRound): CommunityCoverage {
  const start = nsToMs(round.startNs);
  const end = nsToMs(round.endNs);
  const tol = BigInt(round.boundaryToleranceMs);
  const known = samples
    .filter((s) => s.observation.observedAtMs !== null)
    .map((s) => BigInt(s.observation.observedAtMs as string))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hasStart = known.some((t) => t >= start - tol && t <= start + tol);
  const hasEnd = known.some((t) => t >= end - tol && t <= end + tol);
  const gaps: Gap[] = [];
  const max = BigInt(round.maxGapMs);
  // Gaps are measured across the recorded window only, so a missing boundary is a gap too.
  const inWindow = known.filter((t) => t >= start - tol && t <= end + tol);
  const edges = [start, ...inWindow, end];
  for (let i = 1; i < edges.length; i++) {
    if (edges[i]! - edges[i - 1]! > max) gaps.push({ fromMs: edges[i - 1]!.toString(), toMs: edges[i]!.toString() });
  }
  return {
    community,
    samples: samples.length,
    unknownTime: samples.length - known.length,
    hasStart,
    hasEnd,
    gaps,
    firstObservedAtMs: known[0]?.toString() ?? null,
    lastObservedAtMs: known.at(-1)?.toString() ?? null,
    complete: hasStart && hasEnd && gaps.length === 0,
  };
}

export function roundCoverage(state: ObservationState, round: FrozenRound): RoundCoverage {
  const { mine, foreign } = roundSamples(state, round);
  return {
    watermark: state.head,
    revision: state.retracted.size,
    foreign,
    communities: [...round.candidates].sort((a, b) => a - b).map((c) => coverageOf(c, mine.filter((s) => s.observation.community === c), round)),
  };
}

export interface ExactScore {
  community: number;
  negative: boolean;
  numerator: string;
  denominator: string;
}

export type ProvisionalStatus = "provisional" | "incomplete" | "unavailable";
export interface ProvisionalProjection {
  status: ProvisionalStatus;
  /** Always false: this projection is display evidence, never a recorded outcome. */
  authoritative: false;
  mode: Mode;
  reasons: string[];
  scores: Array<ExactScore | null>;
  /** Communities with the best exact score among those that have one; ties list all of them. */
  provisionalLeaders: number[];
  coverage: RoundCoverage;
}

/**
 * Modes a deployment may show scores for. It comes from provider qualification output (#147 / testnet
 * owner), never from this service. Market-cap and volume additionally need their exact inputs: this
 * display projection does not compute them, so they stay unavailable even when named.
 */
export type QualifiedModes = ReadonlySet<Mode>;
export const DISPLAYABLE_MODES: readonly Mode[] = ["PriceGain", "LowestDrawdown"];

type Rational = { negative: boolean; num: bigint; den: bigint };

function cmp(a: Rational, b: Rational): number {
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  const order = a.num * b.den - b.num * a.den;
  const sign = order === 0n ? 0 : order > 0n ? 1 : -1;
  return a.negative ? -sign : sign;
}

function priceGain(start: StoredObservation, end: StoredObservation): Rational | null {
  const s = start.observation.inputs;
  const e = end.observation.inputs;
  if (s.kind !== "price" || e.kind !== "price" || s.priceScale !== e.priceScale) return null;
  const a = BigInt(s.price);
  const b = BigInt(e.price);
  return b < a ? { negative: true, num: a - b, den: a } : { negative: false, num: b - a, den: a };
}

function drawdown(series: StoredObservation[]): Rational | null {
  let scale: number | null = null;
  let peak = 0n;
  let worst: Rational = { negative: false, num: 0n, den: 1n };
  for (const s of series) {
    const i = s.observation.inputs;
    if (i.kind !== "price" || (scale !== null && i.priceScale !== scale)) return null;
    scale = i.priceScale;
    const p = BigInt(i.price);
    if (p > peak) peak = p;
    const next: Rational = { negative: false, num: peak - p, den: peak };
    if (cmp(next, worst) > 0) worst = next;
  }
  return series.length < 2 ? null : worst;
}

function nearest(samples: StoredObservation[], target: bigint, tol: bigint): StoredObservation | null {
  let best: StoredObservation | null = null;
  let bestDist = 0n;
  for (const s of samples) {
    const t = BigInt(s.observation.observedAtMs as string);
    const d = t > target ? t - target : target - t;
    if (d > tol) continue;
    if (best === null || d < bestDist || (d === bestDist && s.seq < best.seq)) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

/** Display projection only: these are not proof of which evidence was submitted on-chain. */
export function projectedBoundaries(state: ObservationState, round: FrozenRound) {
  const { mine } = roundSamples(state, round);
  const tolerance = BigInt(round.boundaryToleranceMs);
  return round.candidates.map((community) => {
    const timed = mine.filter((s) => s.observation.community === community && s.observation.observedAtMs !== null && s.observation.inputs.kind === "price");
    const start = nearest(timed, nsToMs(round.startNs), tolerance);
    const end = nearest(timed, nsToMs(round.endNs), tolerance);
    const describe = (s: StoredObservation | null) => s ? { id: s.id, observedAtMs: s.observation.observedAtMs } : null;
    return { community, start: describe(start), end: describe(end) };
  });
}

export function provisionalProjection(state: ObservationState, round: FrozenRound, qualified: QualifiedModes): ProvisionalProjection {
  const coverage = roundCoverage(state, round);
  const base = { authoritative: false as const, mode: round.mode, coverage };
  if (!DISPLAYABLE_MODES.includes(round.mode)) {
    return { ...base, status: "unavailable", reasons: [`${round.mode} needs exact supply or interval-trade evidence that this display does not compute`], scores: [], provisionalLeaders: [] };
  }
  if (!qualified.has(round.mode)) {
    return { ...base, status: "unavailable", reasons: [`${round.mode} is not qualified for this deployment`], scores: [], provisionalLeaders: [] };
  }
  const { mine } = roundSamples(state, round);
  const start = nsToMs(round.startNs);
  const end = nsToMs(round.endNs);
  const tol = BigInt(round.boundaryToleranceMs);
  const reasons: string[] = [];
  const scored: Array<{ community: number; value: Rational | null }> = [];
  for (const c of [...round.candidates].sort((a, b) => a - b)) {
    const timed = mine
      .filter((s) => s.observation.community === c && s.observation.observedAtMs !== null)
      .sort((a, b) => (BigInt(a.observation.observedAtMs as string) < BigInt(b.observation.observedAtMs as string) ? -1 : 1));
    const cov = coverage.communities.find((x) => x.community === c)!;
    let value: Rational | null = null;
    if (round.mode === "PriceGain") {
      const a = nearest(timed, start, tol);
      const b = nearest(timed, end, tol);
      if (a && b && a.seq !== b.seq) value = priceGain(a, b);
      if (!value) reasons.push(`community ${c}: ${a && b ? "start and end are not comparable" : "missing start or end sample"}`);
    } else if (cov.complete) {
      value = drawdown(timed.filter((s) => BigInt(s.observation.observedAtMs as string) >= start - tol && BigInt(s.observation.observedAtMs as string) <= end + tol));
      if (!value) reasons.push(`community ${c}: drawdown inputs are not comparable`);
    } else {
      reasons.push(`community ${c}: coverage is incomplete (${cov.hasStart ? "" : "no start "}${cov.hasEnd ? "" : "no end "}${cov.gaps.length ? `${cov.gaps.length} gap(s)` : ""})`.replace(/ \)/, ")"));
    }
    scored.push({ community: c, value });
  }
  const complete = scored.length > 0 && scored.every((s) => s.value !== null);
  const have = scored.filter((s): s is { community: number; value: Rational } => s.value !== null);
  let leaders: number[] = [];
  const lowestWins = round.mode === "LowestDrawdown";
  for (const s of have) {
    const order = leaders.length === 0 ? 1 : cmp(s.value, have.find((h) => h.community === leaders[0])!.value) * (lowestWins ? -1 : 1);
    if (order > 0) leaders = [s.community];
    else if (order === 0) leaders.push(s.community);
  }
  return {
    ...base,
    // Even complete evidence stays provisional: only the contract's recorded outcome resolves a round.
    status: complete ? "provisional" : "incomplete",
    reasons: complete ? [] : reasons,
    scores: scored.map((s) => (s.value ? { community: s.community, negative: s.value.negative, numerator: s.value.num.toString(), denominator: s.value.den.toString() } : null)),
    provisionalLeaders: complete ? leaders : [],
    coverage,
  };
}

export const ALL_MODES = MODES;

/** Reader interface the lifecycle scheduler (#147) consumes. It can only read persisted, effective evidence. */
export interface ObservationReader {
  query(q: ObservationQuery): ObservationPage;
  coverage(round: FrozenRound): RoundCoverage;
  projection(round: FrozenRound, qualified: QualifiedModes): ProvisionalProjection;
}

export function readerOver(state: () => ObservationState): ObservationReader {
  return {
    query: (q) => queryObservations(state(), q),
    coverage: (r) => roundCoverage(state(), r),
    projection: (r, q) => provisionalProjection(state(), r, q),
  };
}
