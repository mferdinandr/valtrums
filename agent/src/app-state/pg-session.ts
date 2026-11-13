import pg from "pg";
import type { Db } from "../hosted/db.js";

/**
 * One dedicated database connection that holds a session-level advisory lock for a process's lifetime (the single
 * writer of an observation journal, the single lifecycle oracle). Closing the session, or the process ending, releases
 * the lock, so a crashed process never leaves a lock that needs manual removal. It must reach Postgres in session mode
 * (a direct connection or the Supabase session pooler on port 5432), never through a transaction pooler, which would
 * drop the lock between statements.
 */
export interface LockSession {
  query: Db["query"];
  close(): Promise<void>;
}

/** A dedicated connection to `url`, with the same TLS rule as the shared pool. */
export async function createPgLockSession(url: string): Promise<LockSession> {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    ...(/sslmode=disable|localhost|127\.0\.0\.1/.test(url) ? {} : { ssl: { rejectUnauthorized: false } }),
  });
  await client.connect();
  return {
    query: (async (sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows })) as Db["query"],
    close: () => client.end(),
  };
}

/** Takes the advisory lock named by `name` on `session`; false when another session holds it. */
export async function tryAdvisoryLock(session: LockSession, name: string): Promise<boolean> {
  const { rows } = await session.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtextextended($1, 0)) as ok", [name]);
  return rows[0]?.ok === true;
}
