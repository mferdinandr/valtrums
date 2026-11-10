import { applicationKey, type ApplicationEnvelope, type Namespace } from "./application";

/**
 * Client side of `GET battles/{id}/observations` (OpenSpec arena-market-observations, issue #146).
 * Everything is read through the backend: this file never fetches all history, never joins across a
 * gap and never turns a provisional score into a result. Integers stay decimal strings; the only
 * floats created from them live in the chart adapter and are display geometry.
 */

export type SourceKind = "fixture" | "recorded" | "live";
export interface ObservationItem {
  seq: string;
  id: string;
  battleId: string;
  roundId: string;
  community: number;
  mode: "PriceGain" | "MarketCapGrowth" | "VolumeRatio" | "LowestDrawdown";
  policyHash: string;
  source: { name: string; kind: SourceKind; pool: string | null; quote: string };
  inputs: { kind: "price"; price: string; priceScale: number } | { kind: string; [k: string]: unknown };
  evidenceHash: string;
  observedAtMs: string | null;
  acquiredAtMs: string;
}
export interface CommunityCoverage {
  community: number; samples: number; unknownTime: number; hasStart: boolean; hasEnd: boolean;
  gaps: { fromMs: string; toMs: string }[]; firstObservedAtMs: string | null; lastObservedAtMs: string | null; complete: boolean;
}
export interface ExactScore { community: number; negative: boolean; numerator: string; denominator: string }
export interface ObservationData {
  battleId: string;
  sourceKind: SourceKind | "none";
  sourceKinds: SourceKind[];
  items: ObservationItem[];
  nextCursor: string | null;
  truncated: boolean;
  revision: string;
  retractedSinceCursor: string[];
  recorded: { roundId: string; winner: number | null; candidates: number[]; startNs: string | null; endNs: string | null } | null;
  coverage: { watermark: { seq: number; headHash: string }; revision: number; foreign: number; communities: CommunityCoverage[] } | null;
  projection: { status: "provisional" | "incomplete" | "unavailable"; authoritative: false; mode: string; reasons: string[]; scores: (ExactScore | null)[]; provisionalLeaders: number[] } | null;
}
export type ObservationEnvelope = ApplicationEnvelope<ObservationData>;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export interface ObservationParams { round?: string; community?: number; after?: string; limit?: number }

export class ObservationReadError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: string | null) { super(message); }
}

export async function fetchObservations(namespace: Namespace, battleId: string, params: ObservationParams, signal: AbortSignal,
  doFetch: FetchLike = (u, i) => fetch(u, i)): Promise<ObservationEnvelope> {
  const query = new URLSearchParams({ deployment: namespace.deploymentId, protocol: namespace.protocol });
  if (params.round !== undefined) query.set("round", params.round);
  if (params.community !== undefined) query.set("community", String(params.community));
  if (params.after !== undefined) query.set("after", params.after);
  query.set("limit", String(params.limit ?? 50));
  const res = await doFetch(`/api/arena/v1/battles/${battleId}/observations?${query}`, { method: "GET", cache: "no-store", signal });
  let body: { error?: { message?: string; code?: string } } & Partial<ObservationEnvelope>;
  try { body = await res.json(); } catch { throw new ObservationReadError("Observation reads unavailable", res.status, null); }
  if (!res.ok) throw new ObservationReadError(body?.error?.message ?? "Observation reads unavailable", res.status, body?.error?.code ?? null);
  if (body?.schemaVersion !== "arena-application-v1" || !body.namespace || applicationKey(body.namespace) !== applicationKey(namespace) || !body.provenance || !body.data) {
    throw new ObservationReadError("Observation response namespace/schema mismatch", res.status, null);
  }
  // A response for another battle is foreign evidence, even inside the right namespace.
  if (body.data.battleId !== battleId) throw new ObservationReadError("Observation response is for another battle", res.status, null);
  return body as ObservationEnvelope;
}

export type ChartState = "loading" | "unavailable" | "ready";
export interface ObservationView {
  state: ChartState;
  /** Samples the backend served, oldest first, retractions applied. */
  items: ObservationItem[];
  latest: ObservationEnvelope | null;
  /** A refresh failed after a successful read: the data shown is old and says so. */
  stale: boolean;
  /** More samples exist than the bounded initial load fetched. */
  partial: boolean;
  /** Set when a revision change made the client drop its samples and reload. */
  reconciledAtRevision: string | null;
  error: string | null;
}

export interface PollerOptions {
  fetcher: (params: ObservationParams, signal: AbortSignal) => Promise<ObservationEnvelope>;
  onView: (view: ObservationView) => void;
  /** Display refresh cadence only. It is not the provider's observation cadence. */
  intervalMs?: number;
  /** Pages the initial snapshot may fetch before it declares itself partial. */
  maxSnapshotPages?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ObservationPoller {
  start(): void;
  /** Pause display refreshes (hidden tab). Backend collection is unaffected; resuming refreshes at once. */
  setPaused(paused: boolean): void;
  cancel(): void;
}

/**
 * Cancel-safe delta poller. A snapshot loads bounded pages from the start; later ticks ask only for
 * samples after the last cursor. A different `revision` (a retraction invalidated earlier evidence)
 * discards everything and reloads the snapshot. Every response is checked against the request it
 * answers: a superseded, cancelled or foreign response is ignored, so an old chart can never overwrite
 * a newer one.
 */
export function createObservationPoller(opts: PollerOptions): ObservationPoller {
  const interval = opts.intervalMs ?? 2000;
  const maxPages = opts.maxSnapshotPages ?? 6;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let inflight: AbortController | null = null;
  let generation = 0;
  let paused = false;
  let cancelled = false;
  let started = false;
  let items: ObservationItem[] = [];
  let revision: string | null = null;
  let latest: ObservationEnvelope | null = null;
  let cursor = "0";
  let partial = false;
  let reconciled: string | null = null;
  let snapshotNeeded = true;

  const emit = (extra: Partial<ObservationView> = {}) => {
    const hasData = latest !== null;
    opts.onView({
      state: extra.error && !hasData ? "unavailable" : hasData ? "ready" : "loading",
      items, latest, stale: false, partial, reconciledAtRevision: reconciled, error: null, ...extra,
    });
  };

  const schedule = () => {
    if (cancelled || paused) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => void tick(), interval);
  };

  async function loadSnapshot(gen: number, signal: AbortSignal): Promise<boolean> {
    let next: ObservationItem[] = [];
    let after = "0";
    let last: ObservationEnvelope | null = null;
    let more = false;
    for (let page = 0; page < maxPages; page++) {
      const env = await opts.fetcher({ after }, signal);
      if (gen !== generation || signal.aborted) return false;
      last = env;
      next = [...next, ...env.data.items];
      more = env.data.truncated;
      if (!env.data.truncated || !env.data.nextCursor) { more = false; break; }
      after = env.data.nextCursor;
    }
    if (!last) return false;
    const gone = new Set(last.data.retractedSinceCursor);
    items = next.filter((i) => !gone.has(i.id));
    revision = last.data.revision;
    cursor = items.at(-1)?.seq ?? last.provenance.watermark ?? "0";
    // The cursor of a fully loaded snapshot is the watermark, so a later delta cannot miss or repeat a sample.
    if (!more && last.provenance.watermark) cursor = last.provenance.watermark;
    latest = last;
    partial = more;
    snapshotNeeded = false;
    return true;
  }

  async function tick(): Promise<void> {
    if (cancelled || paused) return;
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;
    const gen = ++generation;
    try {
      if (snapshotNeeded) {
        if (!(await loadSnapshot(gen, controller.signal))) return;
      } else {
        const env = await opts.fetcher({ after: cursor }, controller.signal);
        if (gen !== generation || controller.signal.aborted) return;
        if (env.data.revision !== revision) {
          // Evidence was retracted: never patch, reload everything and say so.
          reconciled = env.data.revision;
          snapshotNeeded = true;
          if (!(await loadSnapshot(gen, controller.signal))) return;
        } else {
          const known = new Set(items.map((i) => i.id));
          items = [...items, ...env.data.items.filter((i) => !known.has(i.id))];
          cursor = env.data.truncated && env.data.nextCursor ? env.data.nextCursor : (env.provenance.watermark ?? cursor);
          latest = env;
        }
      }
      if (gen !== generation) return;
      inflight = null;
      emit();
    } catch (err) {
      if (gen !== generation || controller.signal.aborted) return; // cancelled or superseded
      inflight = null;
      // Keep what was already shown, flagged stale, never replace it with other data.
      emit({ stale: latest !== null, error: err instanceof Error ? err.message : String(err) });
    }
    schedule();
  }

  return {
    start() {
      if (started || cancelled) return;
      started = true;
      emit();
      void tick();
    },
    setPaused(next) {
      if (paused === next || cancelled) return;
      paused = next;
      if (paused) {
        if (timer !== null) clearTimer(timer);
        timer = null;
        generation++; // an answer that arrives while paused must not be applied late
        inflight?.abort();
        inflight = null;
      } else if (started) void tick();
    },
    cancel() {
      cancelled = true;
      generation++;
      if (timer !== null) clearTimer(timer);
      timer = null;
      inflight?.abort();
      inflight = null;
    },
  };
}
