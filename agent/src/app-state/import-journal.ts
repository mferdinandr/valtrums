import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPgDb, type Db } from "../hosted/db.js";
import { loadObservationState, type JournalLine } from "../observations/journal.js";
import { namespaceKey, namespaceSchema, type ObservationNamespace } from "../observations/schema.js";
import { derivedColumns, lineBytes } from "./pg-observation-journal.js";

/**
 * One-time copy of a file observation journal into the database journal (OpenSpec `observation-journal-database`).
 * The whole file must verify first (hash chain and manifest, no torn tail), and every record must belong to the target
 * namespace. Records keep their sequence numbers, previous hashes and hashes, so the database chain is the file chain.
 * It all happens in one transaction. Re-running after a complete import changes nothing, and a namespace that already
 * holds other records is refused. The file is only read.
 */

const BATCH = 200;

export type ImportJournalResult =
  | { status: "imported"; records: number; headHash: string }
  | { status: "already_imported"; records: number; headHash: string };

async function verifiedLines(dir: string, ns: string): Promise<JournalLine[]> {
  // Verifies the chain and the manifest exactly as the read service does; throws on corruption.
  const snapshot = await loadObservationState(dir);
  if (snapshot.tornTail) throw new Error("the journal ends with a torn (unacknowledged) record; open it once with the collector to discard it, then import");
  const text = await readFile(join(dir, "journal.jsonl"), "utf8").catch((err: NodeJS.ErrnoException) => (err.code === "ENOENT" ? "" : Promise.reject(err)));
  const lines = text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as JournalLine);
  if (lines.length !== snapshot.state.head.seq) throw new Error("the journal changed while it was being read; stop the collector and import again");
  for (const line of lines) {
    const owner = namespaceSchema.parse((line.body as { namespace?: unknown }).namespace);
    if (namespaceKey(owner) !== ns) throw new Error(`record ${line.seq} belongs to another namespace than the import target`);
  }
  return lines;
}

export async function importFileJournal(db: Db, dir: string, namespace: ObservationNamespace): Promise<ImportJournalResult> {
  const ns = namespaceKey(namespace);
  const lines = await verifiedLines(dir, ns);
  const headHash = lines.at(-1)?.hash ?? "0".repeat(64);
  return db.transaction(async (tx) => {
    const existing = (await tx.query<{ seq: string | number; hash: string }>(
      "select seq, hash from public.observation_journal where namespace_key = $1 and seq <= $2 order by seq",
      [ns, lines.length],
    )).rows;
    if (existing.length > 0) {
      // Only a complete earlier import of this same journal (possibly with newer records after it) is accepted.
      const same = existing.length === lines.length && existing.every((r, i) => Number(r.seq) === i + 1 && r.hash === lines[i]!.hash);
      if (!same) throw new Error("the database already holds other records for this namespace; nothing was imported");
      return { status: "already_imported", records: lines.length, headHash };
    }
    let bytes = 0;
    for (let i = 0; i < lines.length; i += BATCH) {
      const batch = lines.slice(i, i + BATCH);
      const params: unknown[] = [];
      const values = batch.map((line) => {
        const d = derivedColumns(line);
        const size = lineBytes(line);
        bytes += size;
        const base = params.length;
        params.push(ns, line.seq, line.kind, JSON.stringify(line.body), line.prev, line.hash, d.observation_id, d.slot_key, d.retracts, d.battle_id, d.round_id, size);
        return `(${Array.from({ length: 12 }, (_, k) => `$${base + k + 1}`).join(", ")})`;
      });
      await tx.query(
        `insert into public.observation_journal
           (namespace_key, seq, kind, body, prev_hash, hash, observation_id, slot_key, retracts, battle_id, round_id, line_bytes)
         values ${values.join(", ")}`,
        params,
      );
    }
    if (lines.length > 0) {
      await tx.query(
        "insert into public.observation_journal_head (namespace_key, seq, head_hash, bytes) values ($1, $2, $3, $4)",
        [ns, lines.length, headHash, bytes],
      );
    }
    return { status: "imported", records: lines.length, headHash };
  });
}

/**
 * `pnpm -C agent app:import-journal <journal dir>`: APP_DATABASE_URL and ARENA_APPLICATION_OBSERVATION_SCOPE (the
 * namespace) from the environment. Stop the collector first.
 */
async function main(): Promise<void> {
  const dir = process.argv[2];
  const url = process.env.APP_DATABASE_URL?.trim();
  const scope = process.env.ARENA_APPLICATION_OBSERVATION_SCOPE?.trim();
  if (!dir || !url || !scope) throw new Error("usage: app:import-journal <journal dir>, with APP_DATABASE_URL and ARENA_APPLICATION_OBSERVATION_SCOPE set");
  const db = createPgDb(url);
  try {
    console.log(JSON.stringify({ event: "import-journal", ...(await importFileJournal(db, dir, namespaceSchema.parse(JSON.parse(scope)))) }));
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
