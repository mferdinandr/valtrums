// FIXTURE-ONLY: in-process Postgres (PGlite) running the real migration from supabase/migrations.
import { describe, expect, it } from "vitest";
import { PgHostedRepository } from "../../src/hosted/pg-store.js";
import { DbSessions } from "../../src/hosted/sessions.js";
import type { HostedAgent } from "../../src/hosted/store.js";
import { pgliteWithMigrations } from "./pglite.js";

const agent = (account: string, owner = "o.testnet"): HostedAgent => ({
  account, publicKey: "ed25519:pk", owner, encryptedKey: "v1.a.b.c", style: "crowd", sweep: false, keepWhole: 0,
  running: false, createdAt: 1_000, lastError: null, modelCalls: 0, exports: [],
});

describe("hosted tables: access", () => {
  it("denies the public roles every read and write", async () => {
    const { db, raw } = await pgliteWithMigrations();
    await new PgHostedRepository(db).create(agent("a1"), 5);
    for (const table of ["hosted_agents", "hosted_agent_state", "hosted_agent_events", "hosted_sessions"]) {
      for (const role of ["anon", "authenticated"]) {
        await raw.exec(`set role ${role}`);
        await expect(raw.query(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
        await expect(raw.exec(`delete from public.${table}`)).rejects.toThrow(/permission denied/);
        await raw.exec("reset role");
      }
    }
  });

  it("has row-level security enabled on every table", async () => {
    const { raw } = await pgliteWithMigrations();
    const { rows } = await raw.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relname in ('hosted_agents','hosted_agent_state','hosted_agent_events','hosted_sessions') order by relname",
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
    const policies = await raw.query("select 1 from pg_policies where schemaname = 'public'");
    expect(policies.rows).toHaveLength(0);
  });

  it("rejects bad styles and a negative keep amount at the database", async () => {
    const { db } = await pgliteWithMigrations();
    const repo = new PgHostedRepository(db);
    await expect(repo.create({ ...agent("a1"), style: "wild" as never }, 5)).rejects.toThrow();
    await expect(repo.create({ ...agent("a2"), keepWhole: -1 }, 5)).rejects.toThrow();
  });

  it("does not allow the same account twice", async () => {
    const { db } = await pgliteWithMigrations();
    const repo = new PgHostedRepository(db);
    expect(await repo.create(agent("a1"), 5)).toBe(true);
    await expect(repo.create(agent("a1"), 5)).rejects.toThrow();
  });

  it("removes state and events with the agent", async () => {
    const { db, raw } = await pgliteWithMigrations();
    const repo = new PgHostedRepository(db);
    await repo.create(agent("a1"), 5);
    await repo.saveState("a1", { version: 1, acted: {}, blocked: {}, failures: 0 });
    await raw.exec("delete from public.hosted_agents where account = 'a1'");
    expect((await raw.query("select 1 from public.hosted_agent_state")).rows).toHaveLength(0);
    expect((await raw.query("select 1 from public.hosted_agent_events")).rows).toHaveLength(0);
  });

  it("fails on malformed stored state instead of resetting it", async () => {
    const { db, raw } = await pgliteWithMigrations();
    const repo = new PgHostedRepository(db);
    await repo.create(agent("a1"), 5);
    await raw.exec(`insert into public.hosted_agent_state (account, state) values ('a1', '{"version": 9}')`);
    await expect(repo.loadState("a1")).rejects.toThrow(/malformed/);
  });
});

describe("database sessions", () => {
  it("stores a hash, accepts the token, and rejects it after expiry or sign-out", async () => {
    const { db, raw } = await pgliteWithMigrations();
    let now = 1_000_000;
    const sessions = new DbSessions(db, () => now);
    const token = await sessions.issue("o.testnet", 60_000);
    const stored = (await raw.query<{ token_hash: string }>("select token_hash from public.hosted_sessions")).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.token_hash).not.toContain(token);
    expect(stored[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await sessions.read(token)).toBe("o.testnet");
    expect(await sessions.read("something-else")).toBeNull();
    expect(await sessions.read(undefined)).toBeNull();
    now += 61_000;
    expect(await sessions.read(token)).toBeNull();
    const second = await sessions.issue("o.testnet", 60_000);
    await sessions.revoke(second);
    expect(await sessions.read(second)).toBeNull();
  });

  it("removes expired rows when a new session is issued", async () => {
    const { db, raw } = await pgliteWithMigrations();
    let now = 1_000_000;
    const sessions = new DbSessions(db, () => now);
    await sessions.issue("a.testnet", 1_000);
    now += 5_000;
    await sessions.issue("b.testnet", 60_000);
    expect((await raw.query("select 1 from public.hosted_sessions")).rows).toHaveLength(1);
  });
});
