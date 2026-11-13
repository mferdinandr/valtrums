// FIXTURE-ONLY: synthetic observations on an in-process Postgres (PGlite) running the real migrations. No network.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { PgObservationJournal, PgObservationReader } from "../../src/app-state/pg-observation-journal.js";
import type { LockSession } from "../../src/app-state/pg-session.js";
import type { Db } from "../../src/hosted/db.js";
import {
  ObservationCapacityError,
  ObservationConflictError,
  ObservationCorruptError,
  ObservationJournal,
  ObservationLockedError,
  ObservationValidationError,
} from "../../src/observations/journal.js";
import { namespaceKey, type ObservationNamespace } from "../../src/observations/schema.js";
import { pgliteWithMigrations } from "../hosted/pglite.js";
import { NS, START_MS, price } from "../observations/fixtures.js";

// One database for the file; every test writes its own namespace, which the journal scopes by.
let db: Db;
let raw: PGlite;
beforeAll(async () => {
  ({ db, raw } = await pgliteWithMigrations());
});

let n = 0;
const fresh = (): ObservationNamespace => ({ ...NS, deploymentId: `pg-${++n}` });
const at = (ns: ObservationNamespace, community: number, offsetMs: bigint, value: string) =>
  price(community, START_MS + offsetMs, value, { namespace: { ...ns } });

/** PGlite is a single session, so the advisory lock always succeeds there; `locked` simulates another holder. */
function session(opts: { locked?: boolean } = {}): LockSession & { closed: boolean } {
  const s = {
    closed: false,
    query: (async (sql: string, params?: unknown[]) =>
      opts.locked && sql.includes("pg_try_advisory_lock") ? { rows: [{ ok: false }] } : db.query(sql, params)) as Db["query"],
    close: async () => void (s.closed = true),
  };
  return s;
}
const open = (ns: ObservationNamespace, opts = {}) => PgObservationJournal.open({ db, session: session(), namespace: ns }, opts);

describe("observation journal schema", () => {
  it("refuses update, delete and truncate of journal rows", async () => {
    const ns = fresh();
    const j = await open(ns);
    await j.append(at(ns, 0, 0n, "100"));
    const key = namespaceKey(ns);
    await expect(raw.query("update public.observation_journal set kind = 'retraction' where namespace_key = $1", [key])).rejects.toThrow(/append-only/);
    await expect(raw.query("delete from public.observation_journal where namespace_key = $1", [key])).rejects.toThrow(/append-only/);
    await expect(raw.exec("truncate public.observation_journal")).rejects.toThrow(/append-only/);
  });

  it("enforces one observation per source slot in the database itself", async () => {
    const ns = fresh();
    const j = await open(ns);
    await j.append(at(ns, 0, 0n, "100"));
    const row = (await raw.query<Record<string, unknown>>("select * from public.observation_journal where namespace_key = $1", [namespaceKey(ns)])).rows[0]!;
    await expect(raw.query(
      `insert into public.observation_journal (namespace_key, seq, kind, body, prev_hash, hash, observation_id, slot_key, line_bytes)
       values ($1, 2, 'observation', '{}', $2, $2, $3, $4, 10)`,
      [namespaceKey(ns), row.hash, "f".repeat(64), row.slot_key],
    )).rejects.toThrow(/duplicate key/);
  });

  it("is closed to the public API roles", async () => {
    const { rows } = await raw.query("select table_name from information_schema.role_table_grants where grantee in ('anon', 'authenticated') and table_name in ('observation_journal', 'observation_journal_head', 'lifecycle_oracle_status')");
    expect(rows).toEqual([]);
  });
});

describe("Postgres observation journal writer", () => {
  it("chains records exactly like the file journal", async () => {
    const ns = fresh();
    const a = at(ns, 0, 0n, "100");
    const b = at(ns, 1, 1000n, "200");
    const dir = await mkdtemp(join(tmpdir(), "obs-pg-eq-"));
    try {
      const file = await ObservationJournal.open(dir);
      await file.append(a);
      await file.append(b);
      const pg = await open(ns);
      await pg.append(a);
      await pg.append(b);
      expect(pg.state.head).toEqual(file.state.head);
      await file.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("survives a restart with the same order and head, and deduplicates", async () => {
    const ns = fresh();
    const j = await open(ns);
    const a = at(ns, 0, 0n, "100");
    expect((await j.append(a)).status).toBe("created");
    await j.append(at(ns, 1, 1000n, "200"));
    const head = j.state.head;
    await j.close();
    const again = await open(ns);
    expect(again.state.head).toEqual(head);
    expect(again.state.observations.map((o) => o.observation.community)).toEqual([0, 1]);
    expect(await again.append(a)).toMatchObject({ status: "duplicate", seq: 1 });
    expect(again.state.head.seq).toBe(2);
  });

  it("refuses a second observation for the same source slot and degrades", async () => {
    const ns = fresh();
    const j = await open(ns);
    const a = at(ns, 0, 0n, "100");
    await j.append(a);
    await expect(j.append({ ...a, inputs: { kind: "price", price: "101", priceScale: 8 } })).rejects.toBeInstanceOf(ObservationConflictError);
    expect(j.health()).toEqual({ status: "degraded", reasons: ["conflicting_source_evidence"] });
    expect(j.state.head.seq).toBe(1);
  });

  it("refuses an observation of another namespace", async () => {
    const ns = fresh();
    const j = await open(ns);
    await expect(j.append(at(fresh(), 0, 0n, "100"))).rejects.toBeInstanceOf(ObservationValidationError);
  });

  it("retracts without erasing, idempotently", async () => {
    const ns = fresh();
    const j = await open(ns);
    const { id } = await j.append(at(ns, 0, 0n, "100"));
    const r = { namespace: { ...ns }, observationId: id, reason: "source reorg", acquiredAtMs: "5" };
    expect((await j.retract(r)).status).toBe("created");
    expect((await j.retract(r)).status).toBe("duplicate");
    const state = await new PgObservationReader(db, ns).load();
    expect(state.byId.has(id)).toBe(true);
    expect(state.isEffective(id)).toBe(false);
  });

  it("makes capacity a visible error and adds nothing", async () => {
    const ns = fresh();
    const j = await open(ns, { maxRecords: 1 });
    await j.append(at(ns, 0, 0n, "100"));
    await expect(j.append(at(ns, 1, 0n, "100"))).rejects.toBeInstanceOf(ObservationCapacityError);
    expect(j.health().reasons).toContain("capacity_records");
    expect((await new PgObservationReader(db, ns).load()).head.seq).toBe(1);
  });

  it("refuses a second writer and releases its session", async () => {
    const ns = fresh();
    const s = session({ locked: true });
    await expect(PgObservationJournal.open({ db, session: s, namespace: ns })).rejects.toBeInstanceOf(ObservationLockedError);
    expect(s.closed).toBe(true);
  });

  it("acknowledges nothing when the commit fails, and re-reads before the next write when it may have landed", async () => {
    const ns = fresh();
    let mode: "ok" | "fail_before" | "fail_after" = "ok";
    const flaky: Db = {
      query: db.query,
      transaction: async (fn) => {
        if (mode === "fail_before") throw new Error("connection lost");
        const out = await db.transaction(fn);
        if (mode === "fail_after") throw new Error("connection lost after commit");
        return out;
      },
    };
    const j = await PgObservationJournal.open({ db: flaky, session: session(), namespace: ns });
    const a = at(ns, 0, 0n, "100");
    // The commit landed but the answer was lost: not visible to this writer's publishers...
    mode = "fail_after";
    await expect(j.append(a)).rejects.toThrow("after commit");
    expect(j.state.byId.size).toBe(0);
    expect(j.health().reasons).toEqual(["database_write_failed"]);
    mode = "ok";
    // ...and the retry finds its own committed record instead of breaking the chain.
    expect(await j.append(a)).toMatchObject({ status: "duplicate", seq: 1 });
    expect(j.health().status).toBe("healthy");
    // A commit that never happened: nothing is acknowledged or visible, and the next write simply follows.
    const b = at(ns, 1, 0n, "100");
    mode = "fail_before";
    await expect(j.append(b)).rejects.toThrow("connection lost");
    expect(j.state.head.seq).toBe(1);
    mode = "ok";
    expect(await j.append(b)).toMatchObject({ status: "created", seq: 2 });
  });
});

describe("Postgres observation journal reader", () => {
  it("loads once, then only the records after the head it holds", async () => {
    const ns = fresh();
    const j = await open(ns);
    await j.append(at(ns, 0, 0n, "100"));
    let rowsRead = 0;
    const counting: Db = {
      query: db.query,
      transaction: (fn) => db.transaction((tx) => fn({ ...tx, query: (async (sql: string, params?: unknown[]) => {
        const out = await tx.query(sql, params);
        if (sql.includes("from public.observation_journal\n")) rowsRead += out.rows.length;
        return out;
      }) as Db["query"] })),
    };
    const reader = new PgObservationReader(counting, ns);
    expect((await reader.load()).head.seq).toBe(1);
    expect(rowsRead).toBe(1);
    await j.append(at(ns, 1, 0n, "100"));
    await j.append(at(ns, 0, 1000n, "110"));
    expect((await reader.load()).head.seq).toBe(3);
    expect(rowsRead).toBe(3);
  });

  it("reports a tampered body as corruption, and keeps reporting it", async () => {
    const ns = fresh();
    const j = await open(ns);
    await j.append(at(ns, 0, 0n, "100"));
    await raw.exec("alter table public.observation_journal disable trigger observation_journal_no_change");
    try {
      await raw.query("update public.observation_journal set body = jsonb_set(body, '{inputs,price}', '\"999\"') where namespace_key = $1", [namespaceKey(ns)]);
    } finally {
      await raw.exec("alter table public.observation_journal enable trigger observation_journal_no_change");
    }
    const reader = new PgObservationReader(db, ns);
    await expect(reader.load()).rejects.toBeInstanceOf(ObservationCorruptError);
    await expect(reader.load()).rejects.toBeInstanceOf(ObservationCorruptError);
  });

  it("reports a missing record and a head that disagrees with the rows", async () => {
    const gap = fresh();
    const j = await open(gap);
    await j.append(at(gap, 0, 0n, "100"));
    await j.append(at(gap, 1, 0n, "100"));
    await raw.exec("alter table public.observation_journal disable trigger observation_journal_no_change");
    try {
      await raw.query("delete from public.observation_journal where namespace_key = $1 and seq = 1", [namespaceKey(gap)]);
    } finally {
      await raw.exec("alter table public.observation_journal enable trigger observation_journal_no_change");
    }
    await expect(new PgObservationReader(db, gap).load()).rejects.toThrow(/hash chain broken|missing/);

    const ahead = fresh();
    const k = await open(ahead);
    await k.append(at(ahead, 0, 0n, "100"));
    await raw.query("update public.observation_journal_head set seq = 0 where namespace_key = $1", [namespaceKey(ahead)]);
    await expect(new PgObservationReader(db, ahead).load()).rejects.toThrow(/beyond the journal head/);
  });

  it("never returns an empty state when the database is unreachable, and recovers afterwards", async () => {
    const ns = fresh();
    const j = await open(ns);
    await j.append(at(ns, 0, 0n, "100"));
    let down = true;
    const unreliable: Db = {
      query: db.query,
      transaction: async (fn) => {
        if (down) throw new Error("connect ETIMEDOUT");
        return db.transaction(fn);
      },
    };
    const reader = new PgObservationReader(unreliable, ns);
    await expect(reader.load()).rejects.toThrow("ETIMEDOUT");
    down = false;
    expect((await reader.load()).head.seq).toBe(1);
  });
});
