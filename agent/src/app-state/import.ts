import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_BASELINE_PATH, type Baseline } from "../baseline.js";
import { DEFAULT_REPORT_ARCHIVE_PATH, resolveArchivePath } from "../audit/config.js";
import { JsonFileReportArchive, type ArchivedObservation } from "../audit/report-archive.js";
import { createPgDb, type Db } from "../hosted/db.js";
import { ACTION_STORE_VERSION, type ActionRecord } from "../mcp/actions/store.js";
import { validatePlayerState, type PlayerStateData } from "../player/state.js";

/**
 * One-time import of the local files into the application tables (OpenSpec `app-state-database`). Safe to run twice:
 * rows that already exist are left as they are, files are never modified, and a malformed file stops the import
 * instead of being skipped. Audit observations keep their original `seq` and `archivedAt`.
 */
export interface AppStateFiles {
  actions: Map<string, ActionRecord>;
  observations: ArchivedObservation[];
  baselines: Map<number, Baseline>;
  playerStates: Map<string, PlayerStateData>;
}

export interface AppImportResult {
  actions: number;
  observations: number;
  baselines: number;
  playerStates: number;
}

export async function importAppState(db: Db, files: AppStateFiles): Promise<AppImportResult> {
  const result: AppImportResult = { actions: 0, observations: 0, baselines: 0, playerStates: 0 };
  await db.transaction(async (tx) => {
    for (const [id, a] of files.actions) {
      const r = await tx.query(
        "insert into public.actions (action_id, caller, status, record) values ($1, $2, $3, $4) on conflict (action_id) do nothing returning action_id",
        [id, a.caller, a.status, JSON.stringify(a)],
      );
      result.actions += r.rows.length;
    }
    for (const o of files.observations) {
      const { observationId, seq, archivedAt, ...core } = o;
      const r = await tx.query(
        `insert into public.audit_report_observations (seq, observation_id, arena, battle_id, community, evidence_hash, provenance, report_schema_version, observation, archived_at)
         overriding system value values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (observation_id) do nothing returning seq`,
        [seq, observationId, o.domain.arena, o.attribution.battleId, o.attribution.community, o.report.evidenceHash, o.provenance, o.reportSchemaVersion, JSON.stringify(core), new Date(archivedAt)],
      );
      result.observations += r.rows.length;
    }
    // Imported rows carry their own seq: move the sequence past the largest one so new rows never collide.
    await tx.query(
      `select setval(pg_get_serial_sequence('public.audit_report_observations', 'seq'), greatest((select coalesce(max(seq), 0) from public.audit_report_observations), 1),
         (select count(*) > 0 from public.audit_report_observations))`,
    );
    for (const [battleId, b] of files.baselines) {
      const r = await tx.query("insert into public.watchdog_baselines (battle_id, baseline) values ($1, $2) on conflict (battle_id) do nothing returning battle_id", [battleId, JSON.stringify(b)]);
      result.baselines += r.rows.length;
    }
    for (const [agent, s] of files.playerStates) {
      const r = await tx.query("insert into public.player_state (agent, state) values ($1, $2) on conflict (agent) do nothing returning agent", [agent, JSON.stringify(s)]);
      result.playerStates += r.rows.length;
    }
  });
  return result;
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is not readable JSON; it was not imported`);
  }
};

function readActions(path: string): Map<string, ActionRecord> {
  const file = readJson(path) as { version?: string; actions?: Record<string, ActionRecord> } | null;
  if (file?.version !== ACTION_STORE_VERSION || typeof file.actions !== "object" || file.actions === null) throw new Error(`${path} is not an action store`);
  return new Map(Object.entries(file.actions));
}

function readBaselines(path: string): Map<number, Baseline> {
  const file = readJson(path);
  if (typeof file !== "object" || file === null || Array.isArray(file)) throw new Error(`${path} is not a baseline store`);
  const out = new Map<number, Baseline>();
  for (const [k, v] of Object.entries(file)) {
    if (!/^\d+$/.test(k) || typeof v !== "object" || v === null || !Object.values(v).every((n) => typeof n === "number")) throw new Error(`${path} has a malformed baseline for ${k}`);
    out.set(Number(k), v as Baseline);
  }
  return out;
}

/** Reads every configured file that exists. A file that does not exist is simply not imported. */
export async function readAppStateFiles(env: Record<string, string | undefined>): Promise<AppStateFiles> {
  const files: AppStateFiles = { actions: new Map(), observations: [], baselines: new Map(), playerStates: new Map() };
  const take = (path: string | undefined) => (path && existsSync(path) ? path : null);
  for (const p of [take(env.ACTION_STORE_PATH?.trim()), take(env.PLAYER_ACTION_STORE_PATH?.trim() || "./.data/player-actions.json")]) {
    if (p) for (const [id, a] of readActions(p)) files.actions.set(id, a);
  }
  const archive = take(resolveArchivePath(env) ?? (env.AUDIT_REPORT_ARCHIVE_ENABLED?.trim() === "true" ? DEFAULT_REPORT_ARCHIVE_PATH : undefined));
  if (archive) files.observations = await new JsonFileReportArchive(archive).snapshot(); // re-validates every observation
  const baselines = take(env.BASELINE_STORE_PATH?.trim() || DEFAULT_BASELINE_PATH);
  if (baselines) files.baselines = readBaselines(baselines);
  const grants = take(env.PLAYER_STATE_PATH?.trim() || "./.data/player-state.json");
  if (grants) files.playerStates.set("player:grants", validatePlayerState(readJson(grants) as Partial<PlayerStateData>));
  const auto = take(env.PLAYER_AUTONOMOUS_STATE_PATH?.trim() || "./.agent-state/player-autonomous.json");
  if (auto) files.playerStates.set("player:autonomous", validatePlayerState(readJson(auto) as Partial<PlayerStateData>));
  return files;
}

/** `node dist/app-state/import.js`: set APP_DATABASE_URL and the same path variables the services use. */
async function main(): Promise<void> {
  const url = process.env.APP_DATABASE_URL?.trim();
  if (!url) throw new Error("set APP_DATABASE_URL");
  const files = await readAppStateFiles(process.env);
  const db = createPgDb(url);
  try {
    console.log(JSON.stringify({ event: "import", read: { actions: files.actions.size, observations: files.observations.length, baselines: files.baselines.size, playerStates: files.playerStates.size }, imported: await importAppState(db, files) }));
  } finally {
    await db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(JSON.stringify({ event: "fatal", message: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
