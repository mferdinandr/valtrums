/**
 * Which observation journal a process uses (OpenSpec `observation-journal-database`): the file journal in
 * `OBSERVATION_JOURNAL_DIR` (the default), or the application database with `OBSERVATION_JOURNAL_STORE=database`.
 * The collector, the lifecycle oracle and the read API must use the same one, so the launchers set the switch for all
 * three. `APP_DATABASE_URL` alone never switches: it is already set for other application stores.
 * The lifecycle oracle status follows the same switch. Messages name variables only.
 */
export type JournalStore = { kind: "file"; dir: string } | { kind: "database"; url: string };

/** The configured store, or null when neither a journal directory nor the database store is configured. */
export function journalStoreFromEnv(env: Record<string, string | undefined>): JournalStore | null {
  const store = env.OBSERVATION_JOURNAL_STORE?.trim() || "file";
  if (store !== "file" && store !== "database") throw new Error('OBSERVATION_JOURNAL_STORE must be "file" or "database"');
  const dir = env.OBSERVATION_JOURNAL_DIR?.trim();
  if (store === "database") {
    const url = env.APP_DATABASE_URL?.trim();
    if (!url) throw new Error("OBSERVATION_JOURNAL_STORE=database requires APP_DATABASE_URL");
    if (dir) throw new Error("set only one of OBSERVATION_JOURNAL_STORE=database and OBSERVATION_JOURNAL_DIR");
    return { kind: "database", url };
  }
  return dir ? { kind: "file", dir } : null;
}
