// FIXTURE-ONLY: temporary files and an in-process Postgres (PGlite) running the real migration.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importHostedData, readHostedFiles } from "../../src/hosted/import.js";
import { PgHostedRepository } from "../../src/hosted/pg-store.js";
import type { HostedAgent } from "../../src/hosted/store.js";
import { pgliteWithMigrations } from "./pglite.js";

const agent = (account: string, over: Partial<HostedAgent> = {}): HostedAgent => ({
  account, publicKey: "ed25519:pk", owner: "o.testnet", encryptedKey: "v1.aaa.bbb.ccc", style: "underdog", sweep: true, keepWhole: 7,
  running: true, createdAt: 1_700_000_000_000, lastError: null, modelCalls: 4, exports: [1_700_000_100_000], ...over,
});
const state = { version: 1 as const, acted: { "auto:a1:3": { at: 1, actionId: "x", txHash: "h", status: "sent" } }, blocked: {}, failures: 0 };

describe("hosted import", () => {
  it("loads agents, state and exports without changing any value", async () => {
    const { db } = await pgliteWithMigrations();
    const out = await importHostedData(db, [agent("a1")], new Map([["a1", state]]));
    expect(out).toEqual({ agents: 1, skippedAgents: 0, states: 1 });
    const repo = new PgHostedRepository(db);
    const a = await repo.get("a1");
    expect(a).toMatchObject({ owner: "o.testnet", encryptedKey: "v1.aaa.bbb.ccc", style: "underdog", sweep: true, keepWhole: 7, modelCalls: 4, createdAt: 1_700_000_000_000 });
    expect(a?.running).toBe(false); // an imported agent never starts by itself
    expect(await repo.loadState("a1")).toEqual(state);
    expect(await repo.exportTimes("a1")).toEqual([1_700_000_100_000]);
  });

  it("is safe to run twice", async () => {
    const { db, raw } = await pgliteWithMigrations();
    await importHostedData(db, [agent("a1")], new Map([["a1", state]]));
    const again = await importHostedData(db, [agent("a1", { modelCalls: 999 })], new Map());
    expect(again).toEqual({ agents: 0, skippedAgents: 1, states: 0 });
    expect((await new PgHostedRepository(db).get("a1"))?.modelCalls).toBe(4); // the second run changed nothing
    expect((await raw.query("select 1 from public.hosted_agent_events")).rows).toHaveLength(2); // create + export, once
  });

  it("refuses a key that is not an encrypted blob", async () => {
    const { db } = await pgliteWithMigrations();
    await expect(importHostedData(db, [agent("a1", { encryptedKey: "ed25519:plainsecret" })], new Map())).rejects.toThrow(/not an encrypted blob/);
    expect((await new PgHostedRepository(db).get("a1"))).toBeUndefined();
  });

  it("reads agents.json and the state files from a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosted-import-"));
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ version: 1, agents: { a1: agent("a1") } }));
    writeFileSync(join(dir, "state-a1.json"), JSON.stringify(state));
    const { agents, states } = readHostedFiles(dir);
    expect(agents.map((a) => a.account)).toEqual(["a1"]);
    expect(states.get("a1")).toEqual(state);
  });

  it("stops on a malformed state file instead of skipping it", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosted-import-"));
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ version: 1, agents: { a1: agent("a1") } }));
    writeFileSync(join(dir, "state-a1.json"), JSON.stringify({ version: 9 }));
    expect(() => readHostedFiles(dir)).toThrow(/malformed/);
  });
});
