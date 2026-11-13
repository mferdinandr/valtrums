// FIXTURE-ONLY: temp-directory file journals copied into an in-process Postgres (PGlite) running the real migrations.
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { importFileJournal } from "../../src/app-state/import-journal.js";
import { PgObservationJournal, PgObservationReader } from "../../src/app-state/pg-observation-journal.js";
import type { Db } from "../../src/hosted/db.js";
import { ObservationJournal } from "../../src/observations/journal.js";
import type { ObservationNamespace } from "../../src/observations/schema.js";
import { pgliteWithMigrations } from "../hosted/pglite.js";
import { NS, START_MS, price } from "../observations/fixtures.js";

let db: Db;
beforeAll(async () => {
  ({ db } = await pgliteWithMigrations());
});
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "obs-import-")); });
afterEach(() => rm(dir, { recursive: true, force: true }));

let n = 0;
const fresh = (): ObservationNamespace => ({ ...NS, deploymentId: `import-${++n}` });
async function fileJournal(ns: ObservationNamespace, count: number): Promise<ObservationJournal> {
  const j = await ObservationJournal.open(dir);
  for (let i = 0; i < count; i++) await j.append(price(i % 2, START_MS + BigInt(i) * 1000n, String(100 + i), { namespace: { ...ns } }));
  return j;
}
const session = () => ({ query: db.query, close: async () => undefined });

describe("journal import", () => {
  it("copies a verified journal with its sequence and hashes, and the writer continues the same chain", async () => {
    const ns = fresh();
    const file = await fileJournal(ns, 3);
    const head = file.state.head;
    await file.close();
    expect(await importFileJournal(db, dir, ns)).toEqual({ status: "imported", records: 3, headHash: head.headHash });
    expect((await new PgObservationReader(db, ns).load()).head).toEqual(head);
    const writer = await PgObservationJournal.open({ db, session: session(), namespace: ns });
    expect((await writer.append(price(0, START_MS + 99_000n, "500", { namespace: { ...ns } }))).seq).toBe(4);
  });

  it("is a no-op when repeated", async () => {
    const ns = fresh();
    await (await fileJournal(ns, 2)).close();
    await importFileJournal(db, dir, ns);
    expect((await importFileJournal(db, dir, ns)).status).toBe("already_imported");
    expect((await new PgObservationReader(db, ns).load()).head.seq).toBe(2);
  });

  it("refuses a corrupt journal and writes nothing", async () => {
    const ns = fresh();
    await (await fileJournal(ns, 2)).close();
    const path = join(dir, "journal.jsonl");
    await writeFile(path, (await readFile(path, "utf8")).replace('"price":"100"', '"price":"999"'));
    await expect(importFileJournal(db, dir, ns)).rejects.toThrow(/corrupt/);
    expect((await new PgObservationReader(db, ns).load()).head.seq).toBe(0);
  });

  it("refuses a torn tail, records of another namespace and a namespace that holds other records", async () => {
    const torn = fresh();
    await (await fileJournal(torn, 1)).close();
    await appendFile(join(dir, "journal.jsonl"), '{"seq":2');
    await expect(importFileJournal(db, dir, torn)).rejects.toThrow(/torn/);

    await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(join(tmpdir(), "obs-import-"));
    await (await fileJournal(fresh(), 1)).close();
    await expect(importFileJournal(db, dir, fresh())).rejects.toThrow(/another namespace/);

    const taken = fresh();
    const other = await PgObservationJournal.open({ db, session: session(), namespace: taken });
    await other.append(price(1, START_MS, "7", { namespace: { ...taken } }));
    await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(join(tmpdir(), "obs-import-"));
    await (await fileJournal(taken, 1)).close();
    await expect(importFileJournal(db, dir, taken)).rejects.toThrow(/other records/);
  });
});
