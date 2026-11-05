import { describe, expect, it } from "vitest";
import { loadMarketConfig } from "../src/market-config.js";
import { createMarketData } from "../src/market-wiring.js";
import { FakeArenaClient } from "../src/fake-client.js";
import { RefHoneypotSimulator, RefMarket, RefPriceSource, RefQuoteSource } from "../src/ref-market.js";

const EXCHANGE = "exchange.testnet";
const ADAPTER = "adapter.testnet";
const USDC = "usdc.testnet";
const PEPE = "pepe.testnet";
const SHIB = "shib.testnet";
const E18 = 10n ** 18n;

/** In-memory stand-in for the exchange, the adapter's routing and token metadata. */
class FakeChain {
  routes = new Map<string, number>();
  pools = new Map<number, { tokens: string[]; amounts: bigint[]; fee: number }>();
  decimals = new Map<string, number>();
  metadataCalls = 0;

  addPool(id: number, coin: string, usdc: bigint, coinAmount: bigint, fee = 30) {
    this.pools.set(id, { tokens: [USDC, coin], amounts: [usdc, coinAmount], fee });
    this.routes.set(`${USDC}>${coin}`, id);
    this.routes.set(`${coin}>${USDC}`, id);
  }

  async view<T>(contract: string, method: string, args: object): Promise<T | undefined> {
    const a = args as Record<string, string | number>;
    if (method === "ft_metadata") {
      this.metadataCalls++;
      return { decimals: this.decimals.get(contract) } as T;
    }
    if (contract === ADAPTER && method === "get_pool") {
      return (this.routes.get(`${a.token_in}>${a.token_out}`) ?? null) as T;
    }
    if (contract === EXCHANGE && method === "get_pool") {
      const pool = this.pools.get(Number(a.pool_id));
      if (!pool) return null as T;
      return {
        token_account_ids: pool.tokens,
        amounts: pool.amounts.map(String),
        total_fee: pool.fee,
      } as T;
    }
    if (contract === EXCHANGE && method === "get_return") {
      const pool = this.pools.get(Number(a.pool_id));
      if (!pool) throw new Error("no pool");
      const i = pool.tokens.indexOf(String(a.token_in));
      const o = pool.tokens.indexOf(String(a.token_out));
      const amountIn = BigInt(String(a.amount_in));
      const withFee = amountIn * BigInt(10_000 - pool.fee);
      const out = (withFee * pool.amounts[o]!) / (pool.amounts[i]! * 10_000n + withFee);
      return out.toString() as T;
    }
    throw new Error(`unexpected view ${contract}.${method}`);
  }
}

function setup() {
  const chain = new FakeChain();
  chain.decimals.set(PEPE, 18);
  chain.decimals.set(SHIB, 18);
  // 1 PEPE = 0.001 USDC, 1 SHIB = 0.25 USDC
  chain.addPool(1, PEPE, 100_000n * 10n ** 6n, 100_000_000n * E18);
  chain.addPool(2, SHIB, 100_000n * 10n ** 6n, 400_000n * E18);
  const market = new RefMarket(chain, EXCHANGE, ADAPTER, USDC);
  return { chain, market };
}

describe("RefMarket", () => {
  it("prices a coin from its pool reserves", async () => {
    const { market } = setup();
    expect(await market.priceUsd(PEPE)).toBe(E18 / 1000n);
    expect(await market.priceUsd(SHIB)).toBe(E18 / 4n);
  });

  it("prices USDC at one", async () => {
    const { market } = setup();
    expect(await market.priceUsd(USDC)).toBe(E18);
  });

  it("follows the pool when a trade moves the reserves", async () => {
    const { chain, market } = setup();
    chain.pools.get(1)!.amounts = [125_000n * 10n ** 6n, 80_000_000n * E18];
    expect(await market.priceUsd(PEPE)).toBe((E18 * 125n) / 80_000n);
  });

  it("refuses to price a coin without a pool", async () => {
    const { market } = setup();
    await expect(market.priceUsd("other.testnet")).rejects.toThrow(/no priced/);
  });

  it("refuses to price a coin whose pool is empty", async () => {
    const { chain, market } = setup();
    chain.pools.get(1)!.amounts = [0n, 0n];
    await expect(market.priceUsd(PEPE)).rejects.toThrow(/no priced/);
  });

  it("reports pool depth as twice the USDC side", async () => {
    const { market } = setup();
    expect(await market.liquidityUsd(PEPE)).toBe(200_000);
    expect(await market.liquidityUsd("other.testnet")).toBe(0);
    expect(await market.liquidityUsd(USDC)).toBe(0);
  });

  it("reads token decimals once", async () => {
    const { chain, market } = setup();
    await market.priceUsd(PEPE);
    await market.priceUsd(PEPE);
    expect(chain.metadataCalls).toBe(1);
  });

  it("rejects invalid decimals", async () => {
    const { chain, market } = setup();
    chain.decimals.set(PEPE, 99);
    await expect(market.priceUsd(PEPE)).rejects.toThrow(/invalid decimals/);
  });

  it("ignores a pool that does not pair the coin with USDC", async () => {
    const { chain, market } = setup();
    chain.pools.get(1)!.tokens = [USDC, "other.testnet"];
    expect(await market.reserves(PEPE)).toBeNull();
  });
});

describe("RefPriceSource", () => {
  it("builds history by sampling and trims old samples", async () => {
    const { market } = setup();
    let now = 1_000;
    const source = new RefPriceSource(market, () => now);
    await source.sampleOnce(PEPE);
    now = 2_000;
    await source.sampleOnce(PEPE);
    now = 3_000;
    await source.sampleOnce(PEPE);
    expect((await source.samples(PEPE, 1_500, 3_000)).map((s) => s.tsMs)).toEqual([2_000, 3_000]);
    expect((await source.samples(PEPE, 0, 3_000)).map((s) => s.tsMs)).toEqual([2_000, 3_000]);
  });
});

describe("RefHoneypotSimulator", () => {
  it("passes a coin with a funded pool", async () => {
    const { market } = setup();
    expect((await new RefHoneypotSimulator(market).check(PEPE)).honeypot).toBe(false);
  });

  it("flags a coin without a pool", async () => {
    const { market } = setup();
    const result = await new RefHoneypotSimulator(market).check("other.testnet");
    expect(result.honeypot).toBe(true);
  });

  it("flags a pool with an empty side", async () => {
    const { chain, market } = setup();
    chain.pools.get(2)!.amounts = [100n, 0n];
    expect((await new RefHoneypotSimulator(market).check(SHIB)).honeypot).toBe(true);
  });
});

describe("RefQuoteSource", () => {
  it("quotes through the pool the adapter routes", async () => {
    const { chain } = setup();
    const quotes = new RefQuoteSource(chain, EXCHANGE);
    const out = await quotes.expectedOut(ADAPTER, USDC, PEPE, 10_000_000n);
    // 10 USDC at 0.001 USDC per PEPE, less the 0.3% fee and a sliver of impact.
    expect(out).toBeGreaterThan(9_900n * E18 - 100n * E18);
    expect(out).toBeLessThan(10_000n * E18);
  });

  it("rejects a pair the adapter does not route", async () => {
    const { chain } = setup();
    const quotes = new RefQuoteSource(chain, EXCHANGE);
    await expect(quotes.expectedOut(ADAPTER, USDC, "other.testnet", 1n)).rejects.toThrow(/no pool/);
  });
});

describe("market data configuration", () => {
  it("accepts ref with an exchange", () => {
    const cfg = loadMarketConfig({ MARKET_DATA: "ref", REF_EXCHANGE_ID: EXCHANGE }, 5);
    expect(cfg.marketData).toBe("ref");
    expect(cfg.refExchangeId).toBe(EXCHANGE);
  });

  it("needs the exchange account for ref", () => {
    expect(() => loadMarketConfig({ MARKET_DATA: "ref" }, 5)).toThrow(/REF_EXCHANGE_ID/);
  });

  it("still rejects unknown sources", () => {
    expect(() => loadMarketConfig({ MARKET_DATA: "nope" }, 5)).toThrow(/MARKET_DATA/);
  });

  it("builds ref sources from the arena configuration", async () => {
    const { chain } = setup();
    const client = new FakeArenaClient();
    client.executionDex = ADAPTER;
    const cfg = loadMarketConfig({ MARKET_DATA: "ref", REF_EXCHANGE_ID: EXCHANGE }, 5);
    const sources = await createMarketData(cfg, client, chain, undefined);
    expect(await sources.liquidity.liquidityUsd(SHIB)).toBe(200_000);
  });

  it("needs an execution dex on the arena for ref", async () => {
    const { chain } = setup();
    const client = new FakeArenaClient();
    const cfg = loadMarketConfig({ MARKET_DATA: "ref", REF_EXCHANGE_ID: EXCHANGE }, 5);
    await expect(createMarketData(cfg, client, chain, undefined)).rejects.toThrow(/execution_dex/);
  });
});
