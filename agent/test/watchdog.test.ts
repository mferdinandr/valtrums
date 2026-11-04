import { describe, expect, it } from "vitest";
import type { LiquiditySource } from "../src/auditor.js";
import { InMemoryBaselineStore } from "../src/baseline.js";
import { FakeArenaClient, makeBattle } from "../src/fake-client.js";
import { watchBattle } from "../src/watchdog.js";

type Levels = Record<string, number | Error>;
const source = (levels: Levels): LiquiditySource => ({
  liquidityUsd: async (t) => {
    const v = levels[t];
    if (v === undefined) throw new Error("no data");
    if (v instanceof Error) throw v;
    return v;
  },
});

async function setup(status: "Approved" | "Live" = "Live") {
  const client = new FakeArenaClient([makeBattle({ id: 1, status })]);
  const store = new InMemoryBaselineStore();
  await store.set(1, { "aaa.testnet": 100_000, "bbb.testnet": 40_000 });
  return { client, store, battle: (await client.getBattle(1))! };
}

describe("watchBattle", () => {
  it("halts on a 60% drop, naming token and percentages", async () => {
    const { client, store, battle } = await setup();
    const out = await watchBattle(
      client,
      source({ "aaa.testnet": 40_000, "bbb.testnet": 40_000 }),
      store,
      battle,
    );
    expect(out.action).toBe("halted");
    expect(client.status(1)).toBe("EmergencyHalted");
    const call = client.calls[0]!;
    expect(call.method === "emergency_halt" && call.reason).toMatch(/aaa\.testnet.*60\.0%/);
  });

  it("does nothing on a 20% drop", async () => {
    const { client, store, battle } = await setup("Approved");
    const out = await watchBattle(
      client,
      source({ "aaa.testnet": 80_000, "bbb.testnet": 32_000 }),
      store,
      battle,
    );
    expect(out.action).toBe("ok");
    expect(client.calls).toEqual([]);
  });

  it("exactly 50% is not a halt, just below is", async () => {
    const a = await setup();
    const atBoundary = await watchBattle(
      a.client,
      source({ "aaa.testnet": 50_000, "bbb.testnet": 20_000 }),
      a.store,
      a.battle,
    );
    expect(atBoundary.action).toBe("ok");
    const b = await setup();
    const below = await watchBattle(
      b.client,
      source({ "aaa.testnet": 49_999, "bbb.testnet": 40_000 }),
      b.store,
      b.battle,
    );
    expect(below.action).toBe("halted");
  });

  it("a data-source failure never halts", async () => {
    const { client, store, battle } = await setup();
    const out = await watchBattle(
      client,
      source({ "aaa.testnet": new Error("api down"), "bbb.testnet": new Error("api down") }),
      store,
      battle,
    );
    expect(out.action).toBe("ok");
    expect(client.calls).toEqual([]);
  });

  it("still halts for the readable token when the other source fails", async () => {
    const { client, store, battle } = await setup();
    const out = await watchBattle(
      client,
      source({ "aaa.testnet": new Error("api down"), "bbb.testnet": 1_000 }),
      store,
      battle,
    );
    expect(out.action).toBe("halted");
  });

  it("restart without baselines rebuilds them from current liquidity and does not halt", async () => {
    const client = new FakeArenaClient([makeBattle({ id: 1, status: "Live" })]);
    const store = new InMemoryBaselineStore();
    const battle = (await client.getBattle(1))!;
    const out = await watchBattle(
      client,
      source({ "aaa.testnet": 12_000, "bbb.testnet": 15_000 }),
      store,
      battle,
    );
    expect(out.action).toBe("ok");
    expect(await store.get(1)).toEqual({ "aaa.testnet": 12_000, "bbb.testnet": 15_000 });
    const later = await watchBattle(
      client,
      source({ "aaa.testnet": 4_000, "bbb.testnet": 15_000 }),
      store,
      battle,
    );
    expect(later.action).toBe("halted");
  });

  it("keeps the original baseline across passes", async () => {
    const { client, store, battle } = await setup();
    await watchBattle(client, source({ "aaa.testnet": 90_000, "bbb.testnet": 40_000 }), store, battle);
    expect(await store.get(1)).toEqual({ "aaa.testnet": 100_000, "bbb.testnet": 40_000 });
  });

  it("skips battles that are not Approved or Live", async () => {
    const client = new FakeArenaClient([makeBattle({ id: 1, status: "Settling" })]);
    const out = await watchBattle(
      client,
      source({}),
      new InMemoryBaselineStore(),
      (await client.getBattle(1))!,
    );
    expect(out.action).toBe("skipped");
  });

  it("tolerates a halt rejected because the battle already moved on", async () => {
    const { client, store, battle } = await setup();
    const racing = Object.create(client) as FakeArenaClient;
    racing.emergencyHalt = async (id, r) => {
      await client.emergencyHalt(id, r);
      throw new Error("wrong status");
    };
    const out = await watchBattle(
      racing,
      source({ "aaa.testnet": 1, "bbb.testnet": 40_000 }),
      store,
      battle,
    );
    expect(out.action).toBe("skipped");
  });
});
