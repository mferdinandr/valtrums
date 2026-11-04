import { describe, expect, it } from "vitest";
import { MarketAuditor } from "../src/auditor.js";
import { InMemoryBaselineStore } from "../src/baseline.js";
import { MockStepExecutor } from "../src/executor.js";
import { FakeArenaClient, makeBattle } from "../src/fake-client.js";
import type { LogFields, Logger } from "../src/logger.js";
import { OnChainStepExecutor } from "../src/onchain-executor.js";
import { MockDexQuoteSource, type QuoteSource, minOutFromQuote } from "../src/quote.js";
import { type RuntimeDeps, checkExecutionMode, runOnce } from "../src/runtime.js";
import { loadRuntimeConfig } from "../src/runtime-config.js";
import { type PriceSample, TwapFetcher } from "../src/twap.js";

const E18 = 10n ** 18n;
const MIN = 60_000;
let nowMs = 100 * MIN;
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const DEX = "dex.testnet";

/** Rates as the mock DEX returns them: usdc is "usdc.testnet" in the fake config. */
function dexView(rates: Record<string, [string, string]>, fail = false) {
  const views: { contract: string; method: string; args: object }[] = [];
  const quotes = new MockDexQuoteSource({
    async view<T>(contract: string, method: string, args: object) {
      views.push({ contract, method, args });
      if (fail) throw new Error("rpc down");
      const a = args as { token_in: string; token_out: string };
      const r = rates[`${a.token_in}>${a.token_out}`];
      return (r ? { num: r[0], den: r[1] } : null) as T;
    },
  });
  return { quotes, views };
}

const RATES: Record<string, [string, string]> = {
  "bbb.testnet>usdc.testnet": ["1", "1"], // loser coin B -> USDC
  "usdc.testnet>aaa.testnet": ["3", "1"], // USDC -> winner coin A
};

function recorder() {
  const lines: { level: string; msg: string; fields?: LogFields }[] = [];
  const mk = (level: string) => (msg: string, fields?: LogFields) => void lines.push({ level, msg, fields });
  const log: Logger = { info: mk("info"), warn: mk("warn"), error: mk("error") };
  return { lines, log };
}

function setup(over: { rates?: Record<string, [string, string]>; failView?: boolean } = {}) {
  const client = new FakeArenaClient([
    makeBattle({ id: 1, status: "Live", winner: "A", end_time_ns: ns(nowMs - 1) }),
  ]);
  client.setExecution(DEX, "burn.testnet");
  client.lazyPlan = true;
  client.planTemplate = [
    ["Dump", "100"],
    ["Buy", "90"],
    ["Burn", "4"],
    ["Return", "6"],
  ];
  const { quotes, views } = dexView(over.rates ?? RATES, over.failView);
  const rec = recorder();
  const make = (c: FakeArenaClient = client, q: QuoteSource = quotes) =>
    new OnChainStepExecutor(c, q, { log: rec.log, nowMs: () => nowMs });
  return { client, quotes, views, rec, make };
}

const flat = (price: bigint): PriceSample[] =>
  Array.from({ length: 31 }, (_, i) => ({ tsMs: nowMs - (30 - i) * MIN, price }));

function runtimeDeps(client: FakeArenaClient, over: Partial<RuntimeDeps>): RuntimeDeps {
  return {
    client,
    auditor: new MarketAuditor(
      { liquidityUsd: async () => 50_000 },
      { check: async () => ({ honeypot: false, detail: "ok" }) },
    ),
    baselines: new InMemoryBaselineStore(),
    twap: new TwapFetcher(
      { samples: async () => flat(E18) },
      { now: () => nowMs, backoff: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } },
    ),
    sampler: { sampleOnce: async () => {} },
    liquidity: { liquidityUsd: async () => 50_000 },
    executor: new MockStepExecutor(),
    nowMs: () => nowMs,
    ...over,
  };
}

describe("minOutFromQuote", () => {
  it("floors and applies the tolerance exactly", () => {
    expect(minOutFromQuote(100n, 500)).toBe(95n);
    expect(minOutFromQuote(270n, 500)).toBe(256n); // 256.5 -> 256
    expect(minOutFromQuote(12n, 500)).toBe(11n); // 11.4 -> 11
    expect(minOutFromQuote(10n ** 30n, 1)).toBe(10n ** 30n - 10n ** 26n);
  });
  it("handles the boundaries", () => {
    expect(minOutFromQuote(77n, 0)).toBe(77n);
    expect(minOutFromQuote(1n, 500)).toBe(1n); // never zero
    expect(minOutFromQuote(3n, 9999)).toBe(1n);
  });
  it("rejects a zero quote and a bad tolerance", () => {
    expect(() => minOutFromQuote(0n, 500)).toThrow(/zero/);
    expect(() => minOutFromQuote(10n, 10_000)).toThrow(/basis points/);
    expect(() => minOutFromQuote(10n, -1)).toThrow(/basis points/);
  });
});

describe("MockDexQuoteSource", () => {
  it("reads get_rate on the dex and floors the output", async () => {
    const { quotes, views } = dexView({ "x>y": ["3", "7"] });
    expect(await quotes.expectedOut(DEX, "x", "y", 10n)).toBe(4n);
    expect(views[0]).toEqual({ contract: DEX, method: "get_rate", args: { token_in: "x", token_out: "y" } });
  });
  it("fails when there is no rate", async () => {
    await expect(dexView({}).quotes.expectedOut(DEX, "x", "y", 1n)).rejects.toThrow(/no rate/);
  });
});

describe("OnChainStepExecutor", () => {
  it("drives a whole battle over the fake and never calls report_execution", async () => {
    nowMs = 100 * MIN;
    const { client, make, rec } = setup();
    const ex = make();
    const deps = runtimeDeps(client, {
      onChainExecutor: ex,
      executionMode: "onchain",
      log: rec.log,
    });

    // settle pass: Dump is dispatched in the same pass
    const first = await runOnce(deps);
    expect(first).toMatchObject({ settled: 1, stepsDispatched: 1, errors: 0 });
    expect(client.calls.filter((c) => c.method === "execute_step")).toEqual([
      { method: "execute_step", battleId: 1, stepIndex: 0, minOut: 95n },
    ]);

    // DEX pays the dump proceeds; the lazy tail appears; Buy is dispatched
    expect(client.completeDispatched(1, 0, 100n)).toBe(true);
    await runOnce(deps);
    expect(client.calls.at(-1)).toMatchObject({ stepIndex: 1, minOut: 256n });

    client.completeDispatched(1, 1, 270n);
    await runOnce(deps);
    expect(client.calls.at(-1)).toMatchObject({ stepIndex: 2, minOut: 11n });

    // Burn proceeds: Return is booked right away and the battle settles
    client.completeDispatched(1, 2, 12n);
    const last = await runOnce(deps);
    expect(last.stepsReported).toBe(1);
    expect(client.status(1)).toBe("Settled");
    expect(client.calls.map((c) => c.method)).not.toContain("report_execution");
    const plan = await client.getSettlementPlan(1);
    expect(plan.map((s) => s.realized)).toEqual(["100", "270", "12", "6"]);
  });

  it("does not double-dispatch across repeated passes", async () => {
    const { client, make } = setup();
    await client.settleBattle(1, E18, E18);
    const ex = make();
    for (let i = 0; i < 5; i++) await ex.advance(1);
    expect(client.calls.filter((c) => c.method === "execute_step")).toHaveLength(1);
    expect((await ex.advance(1)).waitingOn).toBe(0);
  });

  it("a restarted executor makes the same decisions from the plan alone", async () => {
    const { client, make } = setup();
    await client.settleBattle(1, E18, E18);
    await make().advance(1);
    const restarted = make();
    expect(await restarted.advance(1)).toMatchObject({ dispatched: [], waitingOn: 0 });
    client.completeDispatched(1, 0, 100n);
    expect(await restarted.advance(1)).toMatchObject({ dispatched: [1] });
    expect(client.calls.filter((c) => c.method === "execute_step")).toHaveLength(2);
  });

  it("books Return and zero-amount steps without a quote", async () => {
    const { client, make, views } = setup();
    client.lazyPlan = false;
    client.planTemplate = [
      ["Dump", "0"],
      ["Buy", "0"],
      ["Burn", "0"],
      ["Return", "5"],
    ];
    await client.settleBattle(1, E18, E18);
    const res = await make().advance(1);
    expect(res.booked).toEqual([0, 1, 2, 3]);
    expect(views).toHaveLength(0);
    expect(client.status(1)).toBe("Settled");
  });

  it("does not dispatch on a zero quote or a failing view, and retries later", async () => {
    const zero = setup({ rates: { ...RATES, "bbb.testnet>usdc.testnet": ["0", "1"] } });
    await zero.client.settleBattle(1, E18, E18);
    expect(await zero.make().advance(1)).toMatchObject({ quoteFailed: true, dispatched: [] });
    expect(zero.client.calls.filter((c) => c.method === "execute_step")).toHaveLength(0);
    expect(zero.rec.lines.some((l) => l.level === "warn" && /zero/.test(l.msg))).toBe(true);

    const bad = setup({ failView: true });
    await bad.client.settleBattle(1, E18, E18);
    expect(await bad.make().advance(1)).toMatchObject({ quoteFailed: true });
    expect(bad.client.calls).toHaveLength(1); // only settle_battle
    // the next pass works once the quote is available again
    const { quotes } = dexView(RATES);
    expect(await bad.make(bad.client, quotes).advance(1)).toMatchObject({ dispatched: [0] });
  });

  it("quotes the right pair per step kind", async () => {
    const { client, make, views } = setup();
    await client.settleBattle(1, E18, E18);
    const ex = make();
    await ex.advance(1);
    client.completeDispatched(1, 0, 100n);
    await ex.advance(1);
    expect(views.map((v) => v.args)).toEqual([
      { token_in: "bbb.testnet", token_out: "usdc.testnet" },
      { token_in: "usdc.testnet", token_out: "aaa.testnet" },
    ]);
  });

  it("rejects proceeds below min_out, which stays dispatched", async () => {
    const { client, make } = setup();
    await client.settleBattle(1, E18, E18);
    const ex = make();
    await ex.advance(1);
    expect(client.completeDispatched(1, 0, 94n)).toBe(false);
    expect((await ex.advance(1)).waitingOn).toBe(0);
    expect(client.calls.filter((c) => c.method === "execute_step")).toHaveLength(1);
  });

  it("retries a refused swap with a fresh min_out", async () => {
    const { client, make } = setup();
    await client.settleBattle(1, E18, E18);
    const ex = make();
    await ex.advance(1);
    client.refuseDispatched(1, 0);
    expect((await client.getSettlementPlan(1))[0]).toMatchObject({ dispatched: false, done: false });
    await ex.advance(1);
    expect(client.calls.filter((c) => c.method === "execute_step")).toHaveLength(2);
    expect((await client.getSettlementPlan(1))[0]?.dispatched).toBe(true);
  });

  it("flags a dispatched step stuck past the timeout, without re-dispatching", async () => {
    nowMs = 100 * MIN;
    const { client, rec } = setup();
    await client.settleBattle(1, E18, E18);
    const ex = new OnChainStepExecutor(client, dexView(RATES).quotes, {
      stepTimeoutMs: 10 * MIN,
      log: rec.log,
      nowMs: () => nowMs,
    });
    await ex.advance(1);
    nowMs += 5 * MIN;
    await ex.advance(1);
    expect(rec.lines.filter((l) => l.level === "error")).toHaveLength(0);
    nowMs += 6 * MIN;
    await ex.advance(1);
    const alerts = rec.lines.filter((l) => l.level === "error");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.fields).toMatchObject({ battleId: 1, step: 0 });
    await ex.advance(1); // throttled
    expect(rec.lines.filter((l) => l.level === "error")).toHaveLength(1);
    expect(client.calls.filter((c) => c.method === "execute_step")).toHaveLength(1);
  });
});

describe("fake contract behavior", () => {
  it("enforces order, duplicates and the report_execution refusal", async () => {
    const { client } = setup();
    client.lazyPlan = false;
    await client.settleBattle(1, E18, E18);
    await expect(client.executeStep(1, 1, 1n)).rejects.toThrow(/out of order/);
    await client.executeStep(1, 0, 1n);
    await expect(client.executeStep(1, 0, 1n)).rejects.toThrow(/already dispatched/);
    await expect(client.reportExecution(1, 0, 1n)).rejects.toThrow(/on-chain execution/);
  });
});

describe("execution mode check", () => {
  it("flags both mismatches and accepts matching configurations", async () => {
    const c = new FakeArenaClient();
    expect(await checkExecutionMode(c, "mock")).toBeNull();
    expect(await checkExecutionMode(c, "onchain")).toMatch(/no execution_dex/);
    c.setExecution(DEX, "burn.testnet");
    expect(await checkExecutionMode(c, "onchain")).toBeNull();
    expect(await checkExecutionMode(c, "mock")).toMatch(/executes on-chain/);
  });

  it("a mismatch pauses settlement but other work keeps running", async () => {
    nowMs = 100 * MIN;
    const client = new FakeArenaClient([
      makeBattle({ id: 1 }), // to audit
      makeBattle({ id: 2, status: "Live", winner: "A", end_time_ns: ns(nowMs - 1) }),
      makeBattle({ id: 3, status: "Settling" }),
    ]);
    client.putPlan(3, [
      { index: 0, kind: "Dump", amount: "5", done: false, dispatched: false, realized: null },
    ]);
    const rec = recorder();
    const deps = runtimeDeps(client, { executionMode: "onchain", log: rec.log });
    const out = await runOnce(deps);
    expect(out).toMatchObject({ audited: 1, settled: 0, stepsReported: 0, stepsDispatched: 0 });
    expect(client.status(1)).toBe("Approved");
    expect(client.status(2)).toBe("Live");
    expect(client.calls.map((c) => c.method)).toEqual(["approve_battle"]);
    expect(rec.lines.some((l) => l.level === "error" && /no execution_dex/.test(l.msg))).toBe(true);

    // and the mirror case: mock mode against an on-chain arena
    client.setExecution(DEX, "burn.testnet");
    const mock = await runOnce({ ...deps, executionMode: "mock" });
    expect(mock.stepsReported).toBe(0);
    expect(client.calls.map((c) => c.method)).not.toContain("report_execution");
  });
});

describe("runtime config", () => {
  it("defaults to mock and parses the on-chain settings", () => {
    expect(loadRuntimeConfig({})).toMatchObject({ executionMode: "mock", slippageBps: 500, stepTimeoutSecs: 600 });
    expect(
      loadRuntimeConfig({ EXECUTION_MODE: "onchain", EXECUTION_SLIPPAGE_BPS: "50", STEP_TIMEOUT_SECS: "90" }),
    ).toMatchObject({ executionMode: "onchain", slippageBps: 50, stepTimeoutSecs: 90 });
  });
  it("rejects bad values", () => {
    expect(() => loadRuntimeConfig({ EXECUTION_MODE: "bogus" })).toThrow(/EXECUTION_MODE/);
    expect(() => loadRuntimeConfig({ EXECUTION_SLIPPAGE_BPS: "10000" })).toThrow(/SLIPPAGE/);
    expect(() => loadRuntimeConfig({ STEP_TIMEOUT_SECS: "0" })).toThrow(/STEP_TIMEOUT/);
  });
});
