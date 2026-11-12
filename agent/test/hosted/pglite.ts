import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "../../src/hosted/db.js";

const MIGRATIONS = join(import.meta.dirname, "../../../supabase/migrations");

/** Runs one real migration file from `supabase/migrations` on an in-process Postgres, with Supabase's public roles. */
export async function pgliteWithMigrations(files: (name: string) => boolean = () => true): Promise<{ db: Db; raw: PGlite }> {
  const raw = new PGlite();
  // Supabase provides these roles; the migrations revoke access from them.
  await raw.exec("create role anon nologin; create role authenticated nologin;");
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && files(f)).sort()) {
    await raw.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  }
  const wrap = (q: { query: PGlite["query"] }): Db["query"] => (async (sql: string, params?: unknown[]) => ({ rows: (await q.query(sql, params)).rows })) as Db["query"];
  const db: Db = {
    query: wrap(raw),
    transaction: (fn) =>
      raw.transaction((tx) =>
        fn({
          query: wrap(tx as unknown as { query: PGlite["query"] }),
          transaction: () => {
            throw new Error("nested transactions are not supported");
          },
        }),
      ),
  };
  return { db, raw };
}
