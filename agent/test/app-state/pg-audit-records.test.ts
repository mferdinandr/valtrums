// FIXTURE-ONLY: synthetic audit decisions on an in-process Postgres (PGlite) running the real migrations.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { AUDIT_RECORD_RETENTION_MS, PgAuditRecordStore } from "../../src/app-state/pg-audit-records.js";
import { approvalStatus } from "../../src/audit/approval.js";
import { evaluateCommunity } from "../../src/audit/decision.js";
import type { Db } from "../../src/hosted/db.js";
import { pgliteWithMigrations } from "../hosted/pglite.js";
import { FIXTURE_RESOLVED, NOW, asset, goplus, lp } from "../audit/fixtures.js";

const pass = () => evaluateCommunity({ asset, goplus: goplus(), lp: lp("10001"), policy: FIXTURE_RESOLVED, now: NOW });
const pending = () => evaluateCommunity({ asset, goplus: goplus(), lp: null, policy: FIXTURE_RESOLVED, now: NOW });

// One database for the file (each PGlite runs every migration); every test uses its own arena, which the store scopes by.
let db: Db;
let raw: PGlite;
beforeAll(async () => {
  ({ db, raw } = await pgliteWithMigrations());
});

describe("PgAuditRecordStore", () => {
  it("a stored decision is what the next process loads, and it still binds the asset and policy", async () => {
    const record = pass();
    await new PgAuditRecordStore(db, "load.testnet").put(4, 1, record);
    const { records, skipped } = await new PgAuditRecordStore(db, "load.testnet").load(NOW);
    expect(skipped).toBe(0);
    expect([...records.keys()]).toEqual(["4:1"]);
    expect(records.get("4:1")).toEqual(record);
    expect(approvalStatus(records.get("4:1"), asset, FIXTURE_RESOLVED, NOW)).toEqual({ valid: true });
  });

  it("replaces the previous decision for the same community", async () => {
    const store = new PgAuditRecordStore(db, "replace.testnet");
    await store.put(4, 0, pending());
    await store.put(4, 0, pass());
    expect((await raw.query("select result from public.lifecycle_audit_records where arena = 'replace.testnet'")).rows).toEqual([{ result: "pass" }]);
  });

  it("keeps arenas apart: the same battle id of another deployment is not loaded", async () => {
    await new PgAuditRecordStore(db, "apart-other.testnet").put(4, 0, pass());
    expect((await new PgAuditRecordStore(db, "apart.testnet").load(NOW)).records.size).toBe(0);
  });

  it("drops long-expired decisions of its own arena on load", async () => {
    const store = new PgAuditRecordStore(db, "prune.testnet");
    const record = pass();
    await store.put(1, 0, record);
    await new PgAuditRecordStore(db, "prune-other.testnet").put(1, 0, record);
    const later = new Date(Date.parse(record.expiresAt!) + AUDIT_RECORD_RETENTION_MS + 1);
    expect((await store.load(later)).records.size).toBe(0);
    // Only this arena's rows are removed.
    const left = await raw.query("select arena from public.lifecycle_audit_records where arena like 'prune%'");
    expect(left.rows).toEqual([{ arena: "prune-other.testnet" }]);
  });

  it("skips a malformed row instead of failing the start, and leaves it for inspection", async () => {
    const store = new PgAuditRecordStore(db, "malformed.testnet");
    await store.put(2, 0, pass());
    await raw.exec(`insert into public.lifecycle_audit_records (arena, battle_id, community, result, decided_at, record)
      values ('malformed.testnet', 2, 1, 'pass', now(), '{"result": "pass"}')`);
    const { records, skipped } = await store.load(NOW);
    expect(skipped).toBe(1);
    expect([...records.keys()]).toEqual(["2:0"]);
    const count = await raw.query("select count(*)::int as n from public.lifecycle_audit_records where arena = 'malformed.testnet'");
    expect(count.rows[0]).toEqual({ n: 2 });
  });

  it("is closed to the public API roles", async () => {
    const { rows } = await raw.query<{ grantee: string }>(
      "select grantee from information_schema.role_table_grants where table_name = 'lifecycle_audit_records' and grantee in ('anon', 'authenticated')",
    );
    expect(rows).toEqual([]);
  });
});
