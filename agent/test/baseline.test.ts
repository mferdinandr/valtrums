import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryBaselineStore, JsonFileBaselineStore } from "../src/baseline.js";
import { MarketAuditor, auditAndAct } from "../src/auditor.js";
import { FakeArenaClient, makeBattle } from "../src/fake-client.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "baselines-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("InMemoryBaselineStore", () => {
  it("returns undefined for unknown battles and copies on read", async () => {
    const s = new InMemoryBaselineStore();
    expect(await s.get(1)).toBeUndefined();
    await s.set(1, { a: 5 });
    const got = (await s.get(1))!;
    got.a = 99;
    expect(await s.get(1)).toEqual({ a: 5 });
  });
});

describe("JsonFileBaselineStore", () => {
  it("creates nested directories and survives a new instance", async () => {
    const path = join(dir, "state", "baselines.json");
    await new JsonFileBaselineStore(path).set(3, { "a.testnet": 25_000, "b.testnet": 40_000 });
    expect(await new JsonFileBaselineStore(path).get(3)).toEqual({
      "a.testnet": 25_000,
      "b.testnet": 40_000,
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty("3");
  });

  it("keeps entries from concurrent writers", async () => {
    const s = new JsonFileBaselineStore(join(dir, "b.json"));
    await Promise.all([s.set(1, { a: 1 }), s.set(2, { a: 2 }), s.set(3, { a: 3 })]);
    expect(await s.get(1)).toEqual({ a: 1 });
    expect(await s.get(2)).toEqual({ a: 2 });
    expect(await s.get(3)).toEqual({ a: 3 });
  });

  it("treats a missing or corrupt file as empty", async () => {
    const path = join(dir, "b.json");
    const s = new JsonFileBaselineStore(path);
    expect(await s.get(1)).toBeUndefined();
    await writeFile(path, "{not json");
    expect(await s.get(1)).toBeUndefined();
    await s.set(1, { a: 1 });
    expect(await s.get(1)).toEqual({ a: 1 });
  });
});

describe("auditor baseline recording", () => {
  const auditor = (liq: number) =>
    new MarketAuditor(
      { liquidityUsd: async (t) => (t === "aaa.testnet" ? liq : 30_000) },
      { check: async () => ({ honeypot: false, detail: "ok" }) },
    );

  it("stores audit-time liquidity when approving", async () => {
    const client = new FakeArenaClient([makeBattle({ id: 1 })]);
    const store = new InMemoryBaselineStore();
    await auditAndAct(client, auditor(20_000), 1, store);
    expect(await store.get(1)).toEqual({ "aaa.testnet": 20_000, "bbb.testnet": 30_000 });
  });

  it("stores nothing when voiding", async () => {
    const client = new FakeArenaClient([makeBattle({ id: 1 })]);
    const store = new InMemoryBaselineStore();
    await auditAndAct(client, auditor(5), 1, store);
    expect(await store.get(1)).toBeUndefined();
  });
});
