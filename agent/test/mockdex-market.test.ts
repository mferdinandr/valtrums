import { describe, expect, it } from "vitest";
import { MarketAuditor } from "../src/auditor.js";
import { InMemoryBaselineStore } from "../src/baseline.js";
import { MockStepExecutor } from "../src/executor.js";
import { FakeArenaClient, makeBattle } from "../src/fake-client.js";
import { loadMarketConfig } from "../src/market-config.js";
import { createMarketData } from "../src/market-wiring.js";
import { MockDexHoneypotSimulator } from "../src/mockdex-honeypot.js";
import { MockDexMarket, MockDexPriceSource, priceFromRate } from "../src/mockdex-market.js";
import { runOnce } from "../src/runtime.js";
import { InsufficientSamplesError, TwapFetcher } from "../src/twap.js";

const DEX = "dex.testnet";
const USDC = "usdc.testnet";
const E18 = 10n ** 18n;
const SEC = 1000;

/** In-memory stand-in for the mock DEX and the token metadata views. */
class FakeChain {
  rates = new Map<string, { num: string; den: string }>();
  liquidity = new Map<string, bigint>();
  decimals = new Map<string, number>();
  metadataCalls = 0;
  setRate(from: string, to: string, num: bigint | number, den: bigint | number) {
    this.rates.set(`${from}>${to}`, { num: String(num), den: String(den) });
  }
  async view<T>(contract: string, method: string, args: object): Promise<T | undefined> {
    const a = args as Record<string, string>;
    if (method === "ft_metadata") {
      this.metadataCalls++;
      return { decimals: this.decimals.get(contract) } as T;
    }
    if (contract !== DEX) throw new Error(`unexpected view ${contract}.${method}`);
    if (method === "get_rate") return (this.rates.get(`${a.token_in}>${a.token_out}`) ?? null) as T;
    if (method === "get_liquidity") return String(this.liquidity.get(a.token ?? "") ?? 0n) as T;
    throw new Error(`unexpected view ${method}`);
  }
}

function setup() {
  const chain = new FakeChain();
  return { chain, market: new MockDexMarket(chain, DEX, USDC) };
}

describe("price from get_rate", () => {
  it("prices a 6-decimal token", async () => {
    const { chain, market } = setup();
    chain.decimals.set("six.testnet", 6);
    chain.setRate("six.testnet", USDC, 2, 1); // $2 per coin
    expect(await market.priceUsd("six.testnet")).toBe(2n * E18);
  });

  it("prices an 18-decimal token", async () => {
    const { chain, market } = setup();
    chain.decimals.set("big.testnet", 18);
    chain.setRate("big.testnet", USDC, 1, E18); // 1 USDC unit per coin = $0.000001
    expect(await market.priceUsd("big.testnet")).toBe(10n ** 12n);
  });

  it("prices a 9-decimal token", async () => {
    const { chain, market } = setup();
    chain.decimals.set("nine.testnet", 9);
    chain.setRate("nine.testnet", USDC, 500_000, 10n ** 9n); // $0.5
    expect(await market.priceUsd("nine.testnet")).toBe(E18 / 2n);
  });

  it("rounds down at the boundary and never goes through a float", () => {
    expect(priceFromRate({ num: 1n, den: 3n }, 6)).toBe(333_333_333_333_333_333n);
    expect(priceFromRate({ num: 2n, den: 3n }, 6)).toBe(666_666_666_666_666_666n);
    // exact on large values a float cannot hold
    const num = 123_456_789_012_345_678_901n;
    expect(priceFromRate({ num, den: 1n }, 6)).toBe(num * 10n ** 18n);
    // one base unit per 10^30 stays below the scale and floors to zero
    expect(priceFromRate({ num: 1n, den: 10n ** 40n }, 6)).toBe(0n);
  });

  it("follows a rate change by the DEX owner", async () => {
    const { chain, market } = setup();
    chain.decimals.set("six.testnet", 6);
    chain.setRate("six.testnet", USDC, 2, 1);
    expect(await market.priceUsd("six.testnet")).toBe(2n * E18);
    chain.setRate("six.testnet", USDC, 3, 1);
    expect(await market.priceUsd("six.testnet")).toBe(3n * E18);
  });

  it("reads decimals once, treats USDC as 6 decimals at $1 and rejects missing rates", async () => {
    const { chain, market } = setup();
    chain.decimals.set("six.testnet", 6);
    chain.setRate("six.testnet", USDC, 1, 1);
    await market.priceUsd("six.testnet");
    await market.priceUsd("six.testnet");
    expect(chain.metadataCalls).toBe(1);
    expect(await market.priceUsd(USDC)).toBe(E18);
    expect(chain.metadataCalls).toBe(1);
    chain.decimals.set("none.testnet", 6);
    await expect(market.priceUsd("none.testnet")).rejects.toThrow(/no none.testnet/);
    chain.setRate("zero.testnet", USDC, 0, 1);
    chain.decimals.set("zero.testnet", 6);
    await expect(market.priceUsd("zero.testnet")).rejects.toThrow();
  });
});

describe("liquidity in USD", () => {
  it("values a token at its price and USDC at face value", async () => {
    const { chain, market } = setup();
    chain.decimals.set("big.testnet", 18);
    chain.setRate("big.testnet", USDC, 1000, E18); // $0.001
    chain.liquidity.set("big.testnet", 50_000_000n * E18); // 50M coins
    chain.liquidity.set(USDC, 12_345_678n); // 12.345678 USDC
    expect(await market.liquidityUsd("big.testnet")).toBe(50_000);
    expect(await market.liquidityUsd(USDC)).toBe(12.345678);
  });

  it("is zero without liquidity and without a rate", async () => {
    const { chain, market } = setup();
    chain.decimals.set("a.testnet", 6);
    expect(await market.liquidityUsd("a.testnet")).toBe(0);
    chain.liquidity.set("a.testnet", 5_000_000n);
    expect(await market.liquidityUsd("a.testnet")).toBe(0);
    chain.setRate("a.testnet", USDC, 2, 1);
    expect(await market.liquidityUsd("a.testnet")).toBe(10);
  });
});

describe("honeypot simulator", () => {
  function listed() {
    const { chain, market } = setup();
    chain.setRate("t.testnet", USDC, 2, 1);
    chain.setRate(USDC, "t.testnet", 1, 2);
    chain.liquidity.set("t.testnet", 1n);
    return { chain, hp: new MockDexHoneypotSimulator(market) };
  }
  it("passes when both directions are priced and the DEX holds the token", async () => {
    expect((await listed().hp.check("t.testnet")).honeypot).toBe(false);
  });
  it("flags a missing reverse rate", async () => {
    const { chain, hp } = listed();
    chain.rates.delete(`${USDC}>t.testnet`);
    const r = await hp.check("t.testnet");
    expect(r.honeypot).toBe(true);
    expect(r.detail).toMatch(/cannot be bought/);
  });
  it("flags a missing sell rate and a zero rate", async () => {
    const { chain, hp } = listed();
    chain.setRate("t.testnet", USDC, 0, 1);
    expect((await hp.check("t.testnet")).detail).toMatch(/cannot be sold/);
  });
  it("flags zero liquidity", async () => {
    const { chain, hp } = listed();
    chain.liquidity.set("t.testnet", 0n);
    const r = await hp.check("t.testnet");
    expect(r.honeypot).toBe(true);
    expect(r.detail).toMatch(/holds none/);
  });
});

describe("twap over a short window", () => {
  const fetcher = (source: MockDexPriceSource, now: () => number) =>
    new TwapFetcher(source, {
      windowMs: 60 * SEC,
      sampleIntervalMs: 30 * SEC,
      now,
      backoff: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });

  it("averages samples taken every 30s and follows a rate change", async () => {
    const { chain, market } = setup();
    chain.decimals.set("six.testnet", 6);
    let now = 1_000 * SEC;
    const source = new MockDexPriceSource(market, () => now);
    const f = fetcher(source, () => now);
    chain.setRate("six.testnet", USDC, 1, 1);
    await source.sampleOnce("six.testnet");
    now += 30 * SEC;
    chain.setRate("six.testnet", USDC, 3, 1);
    await source.sampleOnce("six.testnet");
    now += 30 * SEC;
    await source.sampleOnce("six.testnet");
    // $1 for 30s then $3 for 30s
    expect(await f.fetchTwap("six.testnet")).toBe(2n * E18);
  });

  it("refuses thin history", async () => {
    const { chain, market } = setup();
    chain.decimals.set("six.testnet", 6);
    chain.setRate("six.testnet", USDC, 1, 1);
    let now = 1_000 * SEC;
    const source = new MockDexPriceSource(market, () => now);
    const f = fetcher(source, () => now);
    await source.sampleOnce("six.testnet");
    await expect(f.fetchTwap("six.testnet")).rejects.toBeInstanceOf(InsufficientSamplesError);
    now += 20 * SEC; // first sample 20s old: too young for a 60s window
    await source.sampleOnce("six.testnet");
    await expect(f.fetchTwap("six.testnet")).rejects.toBeInstanceOf(InsufficientSamplesError);
    now += 10 * SEC; // third sample; the first is 30s old, so the window is 30s covered
    await source.sampleOnce("six.testnet");
    now += 30 * SEC; // first sample now 60s old: covers the window
    await expect(f.fetchTwap("six.testnet")).resolves.toBe(E18);
  });
});

describe("market config", () => {
  it("defaults", () => {
    expect(loadMarketConfig({}, 30)).toEqual({
      marketData: "dexscreener",
      twapWindowSecs: 1800,
      minLiquidityUsd: 10_000,
    });
  });
  it("accepts mockdex with a short window", () => {
    expect(
      loadMarketConfig({ MARKET_DATA: "mockdex", TWAP_WINDOW_SECS: "60", MIN_LIQUIDITY_USD: "100" }, 30),
    ).toEqual({ marketData: "mockdex", twapWindowSecs: 60, minLiquidityUsd: 100 });
  });
  it.each([
    [{ MARKET_DATA: "other" }, /MARKET_DATA/],
    [{ TWAP_WINDOW_SECS: "0" }, /TWAP_WINDOW_SECS/],
    [{ TWAP_WINDOW_SECS: "-5" }, /TWAP_WINDOW_SECS/],
    [{ TWAP_WINDOW_SECS: "1.5" }, /TWAP_WINDOW_SECS/],
    [{ TWAP_WINDOW_SECS: "abc" }, /TWAP_WINDOW_SECS/],
    [{ TWAP_WINDOW_SECS: "10" }, /between 30/],
    [{ TWAP_WINDOW_SECS: "99999999" }, /between 30/],
    [{ TWAP_WINDOW_SECS: "59" }, /twice AGENT_INTERVAL_SECS/],
    [{ MIN_LIQUIDITY_USD: "0" }, /MIN_LIQUIDITY_USD/],
    [{ MIN_LIQUIDITY_USD: "1e3" }, /MIN_LIQUIDITY_USD/],
    [{ MIN_LIQUIDITY_USD: "99999999999999" }, /between 1/],
  ])("rejects %j", (env, msg) => {
    expect(() => loadMarketConfig(env, 30)).toThrow(msg);
  });
});

describe("createMarketData", () => {
  it("fails clearly when the arena has no execution dex", async () => {
    const client = new FakeArenaClient();
    const cfg = { marketData: "mockdex" as const, twapWindowSecs: 60, minLiquidityUsd: 100 };
    await expect(createMarketData(cfg, client, new FakeChain(), undefined)).rejects.toThrow(
      /execution_dex/,
    );
  });
  it("uses the dex and usdc from the arena config", async () => {
    const client = new FakeArenaClient();
    client.setExecution(DEX, "burn.testnet");
    const chain = new FakeChain();
    chain.liquidity.set("usdc.testnet", 5_000_000n); // FakeArenaClient reports usdc.testnet
    const cfg = { marketData: "mockdex" as const, twapWindowSecs: 60, minLiquidityUsd: 100 };
    const m = await createMarketData(cfg, client, chain, undefined);
    expect(await m.liquidity.liquidityUsd("usdc.testnet")).toBe(5);
  });
});

describe("end to end over mock tokens", () => {
  it("audits, approves, locks with twap prices and halts on a liquidity cut", async () => {
    const chain = new FakeChain();
    const A = "aaa.testnet";
    const B = "bbb.testnet";
    chain.decimals.set(A, 18);
    chain.decimals.set(B, 6);
    chain.setRate(A, USDC, 1000, E18); // $0.001
    chain.setRate(USDC, A, E18, 1000);
    chain.setRate(B, USDC, 2, 1); // $2
    chain.setRate(USDC, B, 1, 2);
    chain.liquidity.set(A, 50_000_000n * E18); // $50,000
    chain.liquidity.set(B, 50_000n * 10n ** 6n); // $100,000

    const client = new FakeArenaClient([makeBattle({ id: 1, token_a: A, token_b: B })]);
    client.setExecution(DEX, "burn.testnet");
    const market = await createMarketData(
      { marketData: "mockdex", twapWindowSecs: 60, minLiquidityUsd: 10_000 },
      client,
      chain,
      undefined,
    );
    let now = 1_000_000 * SEC;
    // the same market, with samples stamped by the test clock
    const clocked = new MockDexPriceSource(new MockDexMarket(chain, DEX, USDC), () => now);
    const deps = {
      client,
      auditor: new MarketAuditor(market.liquidity, market.honeypot, 10_000),
      baselines: new InMemoryBaselineStore(),
      twap: new TwapFetcher(clocked, {
        windowMs: 60 * SEC,
        sampleIntervalMs: 30 * SEC,
        now: () => now,
        backoff: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      }),
      sampler: clocked,
      liquidity: market.liquidity,
      executor: new MockStepExecutor(),
      nowMs: () => now,
    };

    expect(await runOnce(deps)).toMatchObject({ audited: 1, errors: 0 });
    expect(client.status(1)).toBe("Approved");

    now += 30 * SEC; // one sample only: the lock waits
    expect(await runOnce(deps)).toMatchObject({ locked: 0, errors: 1 });
    expect(client.status(1)).toBe("Approved");

    now += 30 * SEC;
    expect(await runOnce(deps)).toMatchObject({ locked: 1, errors: 0 });
    expect(client.status(1)).toBe("Live");
    expect(client.calls.find((c) => c.method === "set_initial_prices")).toMatchObject({
      priceA: 10n ** 15n,
      priceB: 2n * E18,
    });

    const live = (await client.getBattle(1))!;
    client.put({ ...live, end_time_ns: String(BigInt(now + 3600 * SEC) * 1_000_000n) });

    // exactly half is not a halt
    chain.liquidity.set(A, 25_000_000n * E18);
    expect(await runOnce({ ...deps, watchdog: true })).toMatchObject({ watched: 1, halted: 0 });
    expect(client.status(1)).toBe("Live");

    // cut the DEX liquidity of a token by more than half
    chain.liquidity.set(A, 24_000_000n * E18);
    expect(await runOnce({ ...deps, watchdog: true })).toMatchObject({ halted: 1 });
    expect(client.status(1)).toBe("EmergencyHalted");
  });

  it("voids a battle whose token cannot be bought back", async () => {
    const chain = new FakeChain();
    chain.decimals.set("aaa.testnet", 6);
    chain.decimals.set("bbb.testnet", 6);
    for (const t of ["aaa.testnet", "bbb.testnet"]) {
      chain.setRate(t, USDC, 1, 1);
      chain.liquidity.set(t, 50_000n * 10n ** 6n);
    }
    chain.setRate(USDC, "aaa.testnet", 1, 1); // bbb has no reverse rate
    const client = new FakeArenaClient([makeBattle({ id: 1 })]);
    client.setExecution(DEX, "burn.testnet");
    const market = await createMarketData(
      { marketData: "mockdex", twapWindowSecs: 60, minLiquidityUsd: 10_000 },
      client,
      chain,
      undefined,
    );
    const auditor = new MarketAuditor(market.liquidity, market.honeypot, 10_000);
    const res = await auditor.audit((await client.getBattle(1))!);
    expect(res.passed).toBe(false);
    expect(res.reason).toMatch(/honeypot: bbb.testnet/);
  });
});
