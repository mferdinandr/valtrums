import { JsonFileReportArchive, type ReportArchive } from "../audit/report-archive.js";
import { createPgDb, type Db } from "../hosted/db.js";
import { PgReportArchive } from "./pg-report-archive.js";

/**
 * The application database (OpenSpec `app-state-database`). `APP_DATABASE_URL` is a Postgres (Supabase) connection
 * string held only by the agent services. Unset, every store keeps using its local file, as before. One pool per
 * process, shared by all stores.
 */
let shared: (Db & { close(): Promise<void> }) | null = null;

export function appDb(env: Record<string, string | undefined> = process.env): (Db & { close(): Promise<void> }) | null {
  const url = env.APP_DATABASE_URL?.trim();
  if (!url) return null;
  return (shared ??= createPgDb(url));
}

export async function closeAppDb(): Promise<void> {
  const db = shared;
  shared = null;
  await db?.close();
}

/** The audit report archive: Postgres when `APP_DATABASE_URL` is set, else the JSON file at `path`. */
export function createReportArchive(path: string, env: Record<string, string | undefined> = process.env): ReportArchive {
  const db = appDb(env);
  return db ? new PgReportArchive(db) : new JsonFileReportArchive(path);
}
