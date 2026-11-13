import { DISPLAYABLE_MODES } from "./query.js";
import { MODES, type Mode } from "./schema.js";
import { journalStoreFromEnv } from "./journal-store.js";

/**
 * Settings of the read-only observation service (issue #146). Off unless OBSERVATION_JOURNAL_DIR is
 * set. Qualification and coverage approval are explicit operator inputs taken from the provider
 * qualification record (#147 / testnet owner); nothing here self-certifies a provider.
 * The source label (fixture, recorded or live) is NOT configurable: it is part of each sample.
 */
export interface ObservationConfig {
  /** Journal directory; null with OBSERVATION_JOURNAL_STORE=database. */
  dir: string | null;
  /** Set with OBSERVATION_JOURNAL_STORE=database: the journal (and the oracle status) are read from this database. */
  databaseUrl?: string;
  /** Modes whose scores may be shown. Only price gain and drawdown can ever be displayed. */
  qualifiedModes: ReadonlySet<Mode>;
  /** Both values set together, or coverage and scores stay withheld. */
  coveragePolicy: { boundaryToleranceMs: number; maxGapMs: number } | null;
}

const MAX_MS = 24 * 60 * 60 * 1000;

function boundedMs(env: Record<string, string | undefined>, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > MAX_MS) throw new Error(`${name} must be a positive integer of at most ${MAX_MS} milliseconds`);
  return Number(raw);
}

export function loadObservationConfig(env: Record<string, string | undefined>): ObservationConfig | null {
  const store = journalStoreFromEnv(env);
  if (!store) {
    for (const name of ["OBSERVATION_QUALIFIED_MODES", "OBSERVATION_BOUNDARY_TOLERANCE_MS", "OBSERVATION_MAX_GAP_MS"]) {
      if (env[name]?.trim()) throw new Error(`${name} requires OBSERVATION_JOURNAL_DIR`);
    }
    return null;
  }
  const qualified = new Set<Mode>();
  for (const raw of (env.OBSERVATION_QUALIFIED_MODES?.trim() ?? "").split(",").map((m) => m.trim()).filter(Boolean)) {
    if (!(MODES as readonly string[]).includes(raw)) throw new Error(`OBSERVATION_QUALIFIED_MODES has an unknown mode: ${raw}`);
    if (!DISPLAYABLE_MODES.includes(raw as Mode)) {
      throw new Error(`OBSERVATION_QUALIFIED_MODES cannot enable ${raw}: it needs exact circulating supply or interval-trade evidence this service does not compute`);
    }
    qualified.add(raw as Mode);
  }
  const tolerance = boundedMs(env, "OBSERVATION_BOUNDARY_TOLERANCE_MS");
  const gap = boundedMs(env, "OBSERVATION_MAX_GAP_MS");
  if ((tolerance === undefined) !== (gap === undefined)) throw new Error("OBSERVATION_BOUNDARY_TOLERANCE_MS and OBSERVATION_MAX_GAP_MS must be set together");
  return {
    ...(store.kind === "file" ? { dir: store.dir } : { dir: null, databaseUrl: store.url }),
    qualifiedModes: qualified,
    coveragePolicy: tolerance !== undefined && gap !== undefined ? { boundaryToleranceMs: tolerance, maxGapMs: gap } : null,
  };
}
