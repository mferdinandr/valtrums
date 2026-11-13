import pg from "pg";

/**
 * The only database surface the hosted service uses, so the same repository code runs on a real Postgres connection
 * (`pg`) and, in tests, on an in-process Postgres (PGlite).
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs `fn` in one transaction: it commits when `fn` resolves and rolls back when it throws. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

const connectionOptions = (url: string) => ({
  connectionString: url,
  connectionTimeoutMillis: 10_000,
  // Supabase requires TLS; a local database URL with sslmode=disable still works.
  ...(/sslmode=disable|localhost|127\.0\.0\.1/.test(url) ? {} : { ssl: { rejectUnauthorized: false } }),
});

/** One dedicated connection (not from the pool), for a session-level advisory lock that lives as long as it does. */
export async function connectDedicated(url: string): Promise<pg.Client> {
  const client = new pg.Client({ ...connectionOptions(url), keepAlive: true });
  client.on("error", () => undefined); // reported through the lease's own listener; never an unhandled event
  await client.connect();
  return client;
}

/** A pooled connection to the database named by `url` (the Supabase connection string). */
export function createPgDb(url: string, opts: { max?: number } = {}): Db & { close(): Promise<void> } {
  const pool = new pg.Pool({ ...connectionOptions(url), max: opts.max ?? 5 });
  const wrap = (q: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Db["query"] =>
    (async (sql: string, params?: unknown[]) => ({ rows: (await q.query(sql, params)).rows })) as Db["query"];
  return {
    query: wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      const tx: Db = {
        query: wrap(client),
        transaction: () => {
          throw new Error("nested transactions are not supported");
        },
      };
      try {
        await client.query("begin");
        const out = await fn(tx);
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
