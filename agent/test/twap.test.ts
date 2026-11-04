import { describe, expect, it } from "vitest";
import { FakeArenaClient, makeBattle } from "../src/fake-client.js";
import { DexScreenerClient } from "../src/dexscreener.js";
import {
  DexScreenerPriceSource,
  type PriceSample,
  type PriceSource,
  TwapFetcher,
  computeTwap,
  lockWithInitialPrices,
  parseUsdPrice,
} from "../src/twap.js";

const E18 = 10n ** 18n;
const MIN = 60_000;
const NOW = 100 * MIN;
const noSleep = async () => {};
const backoff = { attempts: 4, baseDelayMs: 100, maxDelayMs: 1_000, sleep: noSleep };

/** One sample per minute across the full window, constant price. */
const flat = (price: bigint, minutes = 30): PriceSample[] =>
  Array.from({ length: minutes + 1 }, (_, i) => ({ tsMs: NOW - (minutes - i) * MIN, price }));

function source(map: Record<string, PriceSample[]>): PriceSource {
  return { samples: async (t) => map[t] ?? [] };
}

describe("parseUsdPrice", () => {
  it("scales decimals to 1e18", () => {
    expect(parseUsdPrice("1")).toBe(E18);
    expect(parseUsdPrice("0.5")).toBe(E18 / 2n);
    expect(parseUsdPrice("0.000001234")).toBe(1_234_000_000_000n);
  });
  it("handles exponent notation and truncates beyond 18 decimals", () => {
    expect(parseUsdPrice("1.2e-7")).toBe(120_000_000_000n);
    expect(parseUsdPrice("0.1234567890123456789")).toBe(123_456_789_012_345_678n);
  });
  it("rejects garbage", () => {
    expect(() => parseUsdPrice("abc")).toThrow();
    expect(() => parseUsdPrice("-1")).toThrow();
  });
});

describe("computeTwap", () => {
  it("weights by time held", () => {
    // 10 for 20 min, 40 for 10 min -> 20
    const s = [
      { tsMs: NOW - 30 * MIN, price: 10n },
      { tsMs: NOW - 10 * MIN, price: 40n },
    ];
    expect(computeTwap(s, NOW - 30 * MIN, NOW)).toBe(20n);
  });
});

describe("TwapFetcher", () => {
  it("computes the initial price payload", async () => {
    const f = new TwapFetcher(source({ "a.near": flat(2n * E18), "b.near": flat(E18 / 4n) }), {
      now: () => NOW,
      backoff,
    });
    const p = await f.initialPrices(makeBattle({ id: 5, token_a: "a.near", token_b: "b.near" }));
    expect(p).toEqual({ battleId: 5, priceA: 2n * E18, priceB: E18 / 4n });
  });

  it("retries a failing API with exponential backoff, then succeeds", async () => {
    let calls = 0;
    const delays: number[] = [];
    const flaky: PriceSource = {
      samples: async () => {
        if (++calls < 3) throw new Error("503");
        return flat(E18);
      },
    };
    const f = new TwapFetcher(flaky, {
      now: () => NOW,
      backoff: { ...backoff, sleep: async (ms) => void delays.push(ms) },
    });
    expect(await f.fetchTwap("a.near")).toBe(E18);
    expect(delays).toEqual([100, 200]);
  });

  it("rejects thin history instead of guessing", async () => {
    const f = new TwapFetcher(source({ "a.near": flat(E18, 5) }), { now: () => NOW, backoff });
    await expect(f.fetchTwap("a.near")).rejects.toThrow(/not enough price history/);
  });
});

describe("lockWithInitialPrices", () => {
  const battle = makeBattle({
    id: 1,
    status: "Approved",
    deposit_deadline_ns: "1000",
    token_a: "a.near",
    token_b: "b.near",
  });

  it("writes prices after the deadline and is idempotent", async () => {
    const client = new FakeArenaClient([battle]);
    const f = new TwapFetcher(source({ "a.near": flat(E18), "b.near": flat(2n * E18) }), {
      now: () => NOW,
      backoff,
    });
    expect(await lockWithInitialPrices(client, f, 1, 1000n)).toBe("locked");
    expect(await lockWithInitialPrices(client, f, 1, 1000n)).toBe("skipped");
    expect(client.calls).toEqual([
      { method: "set_initial_prices", battleId: 1, priceA: E18, priceB: 2n * E18 },
    ]);
  });

  it("does nothing before the deadline", async () => {
    const client = new FakeArenaClient([battle]);
    const f = new TwapFetcher(source({}), { now: () => NOW, backoff });
    expect(await lockWithInitialPrices(client, f, 1, 999n)).toBe("skipped");
  });

  it("never writes a price when the API is unavailable", async () => {
    const client = new FakeArenaClient([battle]);
    const down: PriceSource = { samples: async () => Promise.reject(new Error("api down")) };
    const f = new TwapFetcher(down, { now: () => NOW, backoff });
    await expect(lockWithInitialPrices(client, f, 1, 1000n)).rejects.toThrow("api down");
    expect(client.calls).toEqual([]);
    expect(client.status(1)).toBe("Approved");
  });
});

describe("DexScreenerPriceSource", () => {
  it("samples the deepest priced pair and feeds the fetcher", async () => {
    let t = NOW - 30 * MIN;
    const pair = (usd: number, price: string) => ({
      chainId: "near",
      baseToken: { address: "a.near" },
      quoteToken: { address: "wrap.near" },
      priceUsd: price,
      liquidity: { usd },
    });
    const dex = new DexScreenerClient({
      http: { getJson: async () => ({ pairs: [pair(100, "9"), pair(50_000, "0.5")] }) },
    });
    const src = new DexScreenerPriceSource(dex, () => t);
    for (let i = 0; i <= 30; i++, t += MIN) await src.sampleOnce("a.near");
    t = NOW;
    const f = new TwapFetcher(src, { now: () => NOW, backoff });
    expect(await f.fetchTwap("a.near")).toBe(E18 / 2n);
  });

  it("fails sampling when no priced pair exists", async () => {
    const dex = new DexScreenerClient({ http: { getJson: async () => ({ pairs: [] }) } });
    await expect(new DexScreenerPriceSource(dex).sampleOnce("a.near")).rejects.toThrow(/no priced pair/);
  });
});
