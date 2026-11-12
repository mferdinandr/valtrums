// FIXTURE-ONLY: synthetic evidence and records on an in-process Postgres (PGlite) running the real migrations.
import { describe, expect, it } from "vitest";
import { PgReportArchive } from "../../src/app-state/pg-report-archive.js";
import { PgActionStore, PgBaselineStore, loadPgPlayerState } from "../../src/app-state/pg-stores.js";
import { evaluateCommunity } from "../../src/audit/decision.js";
import { ArchiveConflictError, ArchiveCorruptError, InMemoryReportArchive, type ArchiveObservationInput } from "../../src/audit/report-archive.js";
import { buildAuditReport, type AuditReport } from "../../src/audit/report.js";
import { ActionStoreError, MAX_ACTIONS, type ActionRecord } from "../../src/mcp/actions/store.js";
import { pgliteWithMigrations } from "../hosted/pglite.js";
import { FIXTURE_RESOLVED, NOW, asset, goplus, lp } from "../audit/fixtures.js";

const report = (over: Record<string, string | undefined> = {}): AuditReport =>
  buildAuditReport(evaluateCommunity({ asset, goplus: goplus(over), lp: lp("10001"), policy: FIXTURE_RESOLVED, now: NOW }));
const input = (r: AuditReport, attribution = { arena: "a.testnet", battleId: 1, community: 0 }): ArchiveObservationInput => ({ report: r, attribution, provenance: "fixture" });

const action = (id: string, over: Partial<ActionRecord> = {}): ActionRecord =>
  ({ actionId: id, caller: "u.testnet", request: {}, preview: {}, previewHash: "p", bindingHash: "b", status: "previewed", authorization: null, txHash: null, reason: null, history: [], ...over }) as unknown as ActionRecord;

describe("PgActionStore", () => {
  it("creates, reads and updates an action", async () => {
    const { db } = await pgliteWithMigrations();
    const store = new PgActionStore(db);
    expect(await store.get("a1")).toBeNull();
    const created = await store.update("a1", (cur) => (cur ? cur : action("a1")));
    expect(created.status).toBe("previewed");
    const next = await store.update("a1", (cur) => ({ ...cur!, status: "authorized" }));
    expect(next.status).toBe("authorized");
    expect((await store.get("a1"))?.status).toBe("authorized");
  });

  it("applies concurrent updates to one action without losing any", async () => {
    const { db } = await pgliteWithMigrations();
    const store = new PgActionStore(db);
    await store.update("a1", () => action("a1"));
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.update("a1", (cur) => ({ ...cur!, history: [...cur!.history, { status: "previewed" as const, atMs: i }] }))));
    expect((await store.get("a1"))?.history).toHaveLength(8);
  });

  it("rolls back when the update throws", async () => {
    const { db } = await pgliteWithMigrations();
    const store = new PgActionStore(db);
    await store.update("a1", () => action("a1"));
    await expect(store.update("a1", () => { throw new Error("abort"); })).rejects.toThrow("abort");
    expect((await store.get("a1"))?.status).toBe("previewed");
    await expect(store.update("a2", () => { throw new Error("abort"); })).rejects.toThrow("abort");
    expect(await store.get("a2")).toBeNull();
  });

  it("refuses a new action at capacity and never deletes", async () => {
    const { db, raw } = await pgliteWithMigrations();
    await raw.exec(`insert into public.actions (action_id, caller, status, record)
      select 'x' || g, 'c', 'previewed', jsonb_build_object('actionId', 'x' || g, 'caller', 'c', 'status', 'previewed', 'history', '[]'::jsonb)
      from generate_series(1, ${MAX_ACTIONS}) g`);
    const store = new PgActionStore(db);
    await expect(store.update("new", () => action("new"))).rejects.toBeInstanceOf(ActionStoreError);
    expect((await raw.query("select count(*)::int as n from public.actions")).rows[0]).toEqual({ n: MAX_ACTIONS });
    await expect(store.update("x1", (cur) => ({ ...cur!, status: "failed" }))).resolves.toMatchObject({ status: "failed" }); // existing ones still update
  });

  it("fails on a malformed stored record instead of replacing it", async () => {
    const { db, raw } = await pgliteWithMigrations();
    await raw.exec(`insert into public.actions (action_id, caller, status, record) values ('bad', 'c', 'previewed', '{"nope": true}')`);
    const store = new PgActionStore(db);
    await expect(store.get("bad")).rejects.toBeInstanceOf(ActionStoreError);
    await expect(store.update("bad", (cur) => cur!)).rejects.toBeInstanceOf(ActionStoreError);
  });
});

describe("PgBaselineStore", () => {
  it("returns undefined when missing, stores and overwrites a baseline", async () => {
    const { db } = await pgliteWithMigrations();
    const store = new PgBaselineStore(db);
    expect(await store.get(7)).toBeUndefined();
    await store.set(7, { WALLET: 12_000.5, CASHCAT: 20_000 });
    expect(await store.get(7)).toEqual({ WALLET: 12_000.5, CASHCAT: 20_000 });
    await store.set(7, { WALLET: 1 });
    expect(await store.get(7)).toEqual({ WALLET: 1 });
  });

  it("fails on a malformed baseline instead of treating it as lost", async () => {
    const { db, raw } = await pgliteWithMigrations();
    await raw.exec(`insert into public.watchdog_baselines (battle_id, baseline) values (3, '{"WALLET": "lots"}')`);
    await expect(new PgBaselineStore(db).get(3)).rejects.toThrow(/malformed/);
  });
});

describe("player state in Postgres", () => {
  it("starts empty, saves on flush and is remembered by the next process", async () => {
    const { db } = await pgliteWithMigrations();
    const first = await loadPgPlayerState(db, "agent1");
    expect(first.state.has("k")).toBe(false);
    first.state.markActed("k", { at: 5, actionId: "x", txHash: "h", status: "sent" });
    await first.flush();
    const second = await loadPgPlayerState(db, "agent1");
    expect(second.state.has("k")).toBe(true);
    expect((await loadPgPlayerState(db, "agent2")).state.has("k")).toBe(false); // state is per agent
  });

  it("fails on a malformed row instead of resetting", async () => {
    const { db, raw } = await pgliteWithMigrations();
    await raw.exec(`insert into public.player_state (agent, state) values ('a', '{"version": 9}')`);
    await expect(loadPgPlayerState(db, "a")).rejects.toThrow(/malformed/);
  });
});

describe("PgReportArchive", () => {
  it("stores an observation and returns it identically after a new instance", async () => {
    const { db } = await pgliteWithMigrations();
    const r = report();
    const first = await new PgReportArchive(db).put(input(r));
    expect(first.created).toBe(true);
    const snap = await new PgReportArchive(db).snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.report).toEqual(r);
    expect(snap[0]!.observationId).toBe(first.observation.observationId);
    expect(snap[0]!.domain).toEqual({ arena: "a.testnet", custodyDomain: asset.custodyDomain });
  });

  it("gives the same ids and idempotency as the in-memory archive", async () => {
    const { db } = await pgliteWithMigrations();
    const pg = new PgReportArchive(db);
    const mem = new InMemoryReportArchive();
    for (const i of [input(report()), input(report()), input(report({ sell_tax: "0.01" })), input(report(), { arena: "a.testnet", battleId: 2, community: 1 })]) {
      const a = await pg.put(i);
      const b = await mem.put(i);
      expect([a.observation.observationId, a.created]).toEqual([b.observation.observationId, b.created]);
    }
    expect((await pg.snapshot()).map((o) => o.observationId)).toEqual((await mem.snapshot()).map((o) => o.observationId));
  });

  it("keeps the first timestamps when the same decision is retried", async () => {
    const { db } = await pgliteWithMigrations();
    const a = new PgReportArchive(db);
    const first = await a.put(input(report()));
    const retry = await a.put(input(report()));
    expect(retry.created).toBe(false);
    expect(retry.observation.archivedAt).toBe(first.observation.archivedAt);
    expect(retry.observation.seq).toBe(first.observation.seq);
  });

  it("rejects a conflicting observation id rather than overwriting history", async () => {
    const { db } = await pgliteWithMigrations();
    const a = new PgReportArchive(db, { hashFn: () => "a".repeat(64) });
    await a.put(input(report()));
    await expect(a.put(input(report({ sell_tax: "0.01" })))).rejects.toBeInstanceOf(ArchiveConflictError);
    expect(await a.snapshot()).toHaveLength(1);
  });

  it("is append-only in the database itself: update, delete and truncate are refused", async () => {
    const { db, raw } = await pgliteWithMigrations();
    await new PgReportArchive(db).put(input(report()));
    await expect(raw.exec("update public.audit_report_observations set provenance = 'live'")).rejects.toThrow(/append-only/);
    await expect(raw.exec("delete from public.audit_report_observations")).rejects.toThrow(/append-only/);
    await expect(raw.exec("truncate public.audit_report_observations")).rejects.toThrow(/append-only/);
    expect(await new PgReportArchive(db).snapshot()).toHaveLength(1);
  });

  it("fails loudly when a stored row was tampered with", async () => {
    const { db, raw } = await pgliteWithMigrations();
    await new PgReportArchive(db).put(input(report()));
    await raw.exec("alter table public.audit_report_observations disable trigger audit_report_observations_no_change");
    await raw.exec(`update public.audit_report_observations set observation = jsonb_set(observation, '{provenance}', '"live"')`);
    await expect(new PgReportArchive(db).snapshot()).rejects.toBeInstanceOf(ArchiveCorruptError);
  });

  it("reads one battle through the index, in insertion order", async () => {
    const { db } = await pgliteWithMigrations();
    const a = new PgReportArchive(db);
    await a.put(input(report(), { arena: "a.testnet", battleId: 1, community: 0 }));
    await a.put(input(report(), { arena: "a.testnet", battleId: 2, community: 0 }));
    await a.put(input(report({ sell_tax: "0.01" }), { arena: "a.testnet", battleId: 2, community: 1 }));
    expect((await a.forBattle("a.testnet", 2)).map((o) => o.attribution.community)).toEqual([0, 1]);
    expect(await a.forBattle("a.testnet", 2, 1)).toHaveLength(1);
    expect(await a.forBattle("other.testnet", 2)).toHaveLength(0);
  });

  it("serializes concurrent identical writes into one observation", async () => {
    const { db } = await pgliteWithMigrations();
    const a = new PgReportArchive(db);
    const results = await Promise.all(Array.from({ length: 5 }, () => a.put(input(report()))));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await a.snapshot()).toHaveLength(1);
  });
});

describe("application tables: access", () => {
  it("denies the public roles and has RLS on with no policy", async () => {
    const { raw } = await pgliteWithMigrations();
    const tables = ["actions", "audit_report_observations", "player_state", "watchdog_baselines"];
    const rls = await raw.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = any($1)", [tables]);
    expect(rls.rows).toHaveLength(4);
    expect(rls.rows.every((r) => r.relrowsecurity)).toBe(true);
    expect((await raw.query("select 1 from pg_policies where schemaname = 'public' and tablename = any($1)", [tables])).rows).toHaveLength(0);
    for (const table of tables) {
      for (const role of ["anon", "authenticated"]) {
        await raw.exec(`set role ${role}`);
        await expect(raw.query(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
        await raw.exec("reset role");
      }
    }
  });
});
