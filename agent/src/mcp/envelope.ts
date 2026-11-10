/**
 * Every read tool answers with the same envelope: the data plus where it came from, when it was
 * observed and what it cannot claim. A fixture is always labeled as a fixture.
 */

export type DataOrigin = "live" | "recorded" | "fixture";
export type ReadFreshness = "fresh" | "stale" | "unknown";

export interface SourceInfo {
  /** Network the data describes, e.g. `near-testnet`. */
  network: string;
  kind: DataOrigin;
  /** Human-readable source name, e.g. the contract id or `audit-report-archive`. */
  name: string;
}

export interface ReadEnvelope<T> {
  tool: string;
  network: string;
  source: { kind: DataOrigin; name: string };
  /** ISO time the underlying data was observed, or null when the source does not say. */
  observedAt: string | null;
  freshness: ReadFreshness;
  /** What this answer does not prove. Never empty for fixtures. */
  limitations: string[];
  data: T;
}

export const FIXTURE_LIMITATION = "fixture data: not observed on any live network";

export function freshnessOf(observedAtMs: number | null, nowMs: number, maxAgeMs: number): ReadFreshness {
  if (observedAtMs === null || !Number.isFinite(observedAtMs)) return "unknown";
  const age = nowMs - observedAtMs;
  if (age < 0) return "unknown"; // a future timestamp is not trusted as fresh
  return age <= maxAgeMs ? "fresh" : "stale";
}

export function envelope<T>(
  tool: string,
  source: SourceInfo,
  data: T,
  opts: { observedAtMs: number | null; nowMs: number; maxAgeMs: number; limitations?: string[] },
): ReadEnvelope<T> {
  const limitations = [...(opts.limitations ?? [])];
  if (source.kind === "fixture" && !limitations.includes(FIXTURE_LIMITATION)) limitations.unshift(FIXTURE_LIMITATION);
  return {
    tool,
    network: source.network,
    source: { kind: source.kind, name: source.name },
    observedAt: opts.observedAtMs === null ? null : new Date(opts.observedAtMs).toISOString(),
    freshness: freshnessOf(opts.observedAtMs, opts.nowMs, opts.maxAgeMs),
    limitations,
    data,
  };
}
