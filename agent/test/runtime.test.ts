import { describe, expect, it } from "vitest";
import { MarketAuditor } from "../src/auditor.js";
import { InMemoryBaselineStore } from "../src/baseline.js";
import { MockStepExecutor } from "../src/executor.js";
import { FakeArenaClient, makeBattle } from "../src/fake-client.js";
import { type RuntimeDeps, runOnce } from "../src/runtime.js";
import { type PriceSample, TwapFetcher } from "../src/twap.js";

const E18 = 10n ** 18n;
const MIN = 60_000;
let nowMs = 100 * MIN;
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

const flat = (price: bigint): PriceSample[] =>
  Array.from({ length: 31 }, (_, i) => ({ tsMs: nowMs - (30 - i) * MIN, price }));

function deps(client: FakeArenaClient, over: Partial<RuntimeDeps> = {}) {
  const liquidity = { levels: new Map<string, number>() };
  const sampled: string[] = [];
  const d: RuntimeDeps = {
    client,
    auditor: new MarketAuditor(
      { liquidityUsd: async (t) => liquidity.levels.get(t) ?? 50_000 },
      { check: async () => ({ honeypot: false, detail: "ok" }) },
    ),
    baselines: new InMemoryBaselineStore(),
    twap: new TwapFetcher(
      { samples: async () => flat(E18) },
      { now: () => nowMs, backoff: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } },
    ),
    sampler: { sampleOnce: async (t) => void sampled.push(t) },
    liquidity: { liquidityUsd: async (t) => liquidity.levels.get(t) ?? 50_000 },
    executor: new MockStepExecutor(),
    nowMs: () => nowMs,
    ...over,
  };
  return { d, liquidity, sampled };
}

describe("runOnce", () => {
  it("walks a battle through its whole lifecycle across passes", async () => {
    nowMs = 100 * MIN;
    const client = new FakeArenaClient([makeBattle({ id: 1 })]);
    const { d } = deps(client);

    expect(await runOnce(d)).toMatchObject({ audited: 1 });
    expect(client.status(1)).toBe("Approved");

    // deposit deadline in the fake battle is "1000" ns: already passed
    expect(await runOnce(d)).toMatchObject({ locked: 1 });
    expect(client.status(1)).toBe("Live");

    const b = (await client.getBattle(1))!;
    client.put({ ...b, end_time_ns: ns(nowMs - 1) });
    const settle = await runOnce(d);
    expect(settle).toMatchObject({ settled: 1, stepsReported: 3 });
    expect(client.status(1)).toBe("Settled");
    expect(settle.errors).toBe(0);
  });

  it("a duplicate pass makes no extra calls", async () => {
    nowMs = 100 * MIN;
    const client = new FakeArenaClient([
      makeBattle({ id: 1, status: "Settling" }),
      makeBattle({ id: 2, status: "Live", end_time_ns: ns(nowMs + 99 * MIN) }),
    ]);
    client.putPlan(1, [{ index: 0, kind: "Dump", amount: "5", done: false, realized: null }]);
    const { d } = deps(client);
    await runOnce(d);
    const n = client.calls.length;
    expect(n).toBe(1);
    await runOnce(d);
    expect(client.calls).toHaveLength(n);
  });

  it("samples prices for tokens of Approved and Live battles only", async () => {
    const client = new FakeArenaClient([
      makeBattle({ id: 1, status: "Approved", deposit_deadline_ns: ns(nowMs + MIN) }),
      makeBattle({ id: 2, status: "Live", token_a: "ccc.testnet", token_b: "ddd.testnet", end_time_ns: ns(nowMs + MIN) }),
      makeBattle({ id: 3, status: "Voided", token_a: "eee.testnet", token_b: "fff.testnet" }),
    ]);
    const { d, sampled } = deps(client);
    await runOnce(d);
    expect(new Set(sampled)).toEqual(
      new Set(["aaa.testnet", "bbb.testnet", "ccc.testnet", "ddd.testnet"]),
    );
  });

  it("runs the watchdog only when enabled, and halts a rugged token", async () => {
    nowMs = 100 * MIN;
    const client = new FakeArenaClient([
      makeBattle({ id: 1, status: "Live", end_time_ns: ns(nowMs + 99 * MIN) }),
    ]);
    const { d, liquidity } = deps(client);
    await d.baselines.set(1, { "aaa.testnet": 50_000, "bbb.testnet": 50_000 });
    liquidity.levels.set("aaa.testnet", 10_000);

    await runOnce({ ...d, watchdog: false });
    expect(client.status(1)).toBe("Live");

    const out = await runOnce({ ...d, watchdog: true });
    expect(out).toMatchObject({ watched: 1, halted: 1 });
    expect(client.status(1)).toBe("EmergencyHalted");
  });

  it("a failing battle does not block the others", async () => {
    nowMs = 100 * MIN;
    const client = new FakeArenaClient([makeBattle({ id: 1 }), makeBattle({ id: 2 })]);
    const failing = Object.create(client) as FakeArenaClient;
    failing.approveBattle = async (id) => {
      if (id === 1) throw new Error("rpc error");
      return client.approveBattle(id);
    };
    const { d } = deps(failing);
    const out = await runOnce(d);
    expect(out).toMatchObject({ audited: 1, errors: 1 });
    expect(client.status(2)).toBe("Approved");
  });

  it("restart: a fresh store rebuilds baselines without halting", async () => {
    nowMs = 100 * MIN;
    const client = new FakeArenaClient([
      makeBattle({ id: 1, status: "Live", end_time_ns: ns(nowMs + 99 * MIN) }),
    ]);
    const { d, liquidity } = deps(client, { watchdog: true });
    liquidity.levels.set("aaa.testnet", 3_000); // already low, but no baseline exists
    const out = await runOnce(d);
    expect(out.halted).toBe(0);
    expect(await d.baselines.get(1)).toMatchObject({ "aaa.testnet": 3_000 });
  });
});
