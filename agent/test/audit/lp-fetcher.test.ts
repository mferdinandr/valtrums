// FIXTURE-ONLY: a fake EVM RPC returns synthetic pool state. Not live chain data. The WETH, USDG and
// pool addresses used in docs come from DexScreener and are not verified on-chain by us.
import { describe, expect, it } from "vitest";
import { goplusTarget } from "../../src/audit/decision.js";
import { evaluateLiquidity } from "../../src/audit/liquidity.js";
import { createLpFetcher, validateStablecoins, wethToStableRaw, type PoolConfig, type WethConfig } from "../../src/audit/lp-fetcher.js";
import { SEL_BALANCE_OF, selector } from "../../src/evm-abi.js";
import { withEvmReadRetries } from "../../src/rpc-resilience.js";
import { NOW, REF_CHAIN, REF_TOKEN, TOKEN, asset as testnetAsset } from "./fixtures.js";

// The testnet mock is mapped to a mainnet reference; LP is always read for the reference token.
const asset = { ...testnetAsset, reference: { chainId: REF_CHAIN, token: REF_TOKEN, registryEntryHash: "h" } };
const target = goplusTarget(asset);

const USDG = "0x00000000000000000000000000000000000000c1"; // 6 decimals
const WETH = "0x00000000000000000000000000000000000000c3"; // 18 decimals
const OTHER = "0x00000000000000000000000000000000000000c2";
const POOL1 = "0x00000000000000000000000000000000000000f1";
const POOL2 = "0x00000000000000000000000000000000000000f2";
const PRICE = "0x00000000000000000000000000000000000000e1";

const w = (n: bigint) => n.toString(16).padStart(64, "0");
const a = (addr: string) => addr.slice(2).padStart(64, "0");
const isqrt = (n: bigint): bigint => {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
};
/** sqrtPriceX96 for `num/den` token1 raw units per token0 raw unit. */
const sqrtPrice = (num: bigint, den: bigint) => isqrt((num << 192n) / den);

interface PoolFx {
  t0: string;
  t1: string;
  r0?: bigint;
  r1?: bigint;
  sqrt?: bigint;
}

function rpcFor(
  pools: Record<string, PoolFx>,
  balances: Record<string, bigint> = {},
  opts: { chainId?: bigint; decimals?: Record<string, number> } = {},
) {
  const decimals = opts.decimals ?? { [USDG]: 6 };
  const calls: string[] = [];
  return {
    calls,
    rpc: {
      chainId: async () => opts.chainId ?? 4663n,
      blockNumber: async () => 123n,
      blockTimestamp: async () => BigInt(NOW.getTime() / 1000),
      call: async ({ to, data }: { to: string; data: string }, block?: bigint) => {
        calls.push(`${to}:${data.slice(0, 10)}@${block}`);
        if (block !== 123n) throw new Error("read not pinned to the single block");
        const p = pools[to];
        if (p) {
          if (data === selector("token0()")) return `0x${a(p.t0)}`;
          if (data === selector("token1()")) return `0x${a(p.t1)}`;
          if (data === selector("getReserves()")) return `0x${w(p.r0 ?? 0n)}${w(p.r1 ?? 0n)}${w(0n)}`;
          if (data === selector("slot0()")) return `0x${w(p.sqrt ?? 0n)}${w(0n)}`;
        }
        if (data === selector("decimals()") && decimals[to] !== undefined) return `0x${w(BigInt(decimals[to]!))}`;
        if (data.startsWith(SEL_BALANCE_OF)) {
          const holder = `0x${data.slice(-40)}`;
          const bal = balances[`${to}:${holder}`];
          if (bal !== undefined) return `0x${w(bal)}`;
        }
        throw new Error(`unexpected call ${to} ${data.slice(0, 10)}`);
      },
    },
  };
}

const stable = validateStablecoins({ [USDG]: 6 });
const v2 = (pool: string): PoolConfig => ({ pool, kind: "v2" });
const v3 = (pool: string): PoolConfig => ({ pool, kind: "v3" });
const wethCfg = (over: Partial<WethConfig> = {}): WethConfig => ({
  address: WETH,
  chainId: "4663",
  pricePool: PRICE,
  pricePoolMinUsd: "1000000",
  ...over,
});
const run = (
  rpcBits: ReturnType<typeof rpcFor>,
  pools: PoolConfig[],
  weth?: WethConfig,
) => createLpFetcher({ rpc: rpcBits.rpc, stablecoins: stable, pools, ...(weth ? { weth } : {}) })(asset);

// 1 WETH = 3000 USDG: raw price USDG-raw per WETH-raw = 3000e6 / 1e18.
const E18 = 10n ** 18n;
const priceFx = (wethIsToken0: boolean): PoolFx =>
  wethIsToken0
    ? { t0: WETH, t1: USDG, sqrt: sqrtPrice(3000n * 10n ** 6n, E18) }
    : { t0: USDG, t1: WETH, sqrt: sqrtPrice(E18, 3000n * 10n ** 6n) };

describe("headline quote-balance LP fetcher for the reference token (fixture-only)", () => {
  it("v2 stable quote: counts only the quote reserve; the memecoin side is ignored", async () => {
    const rpc = rpcFor({ [POOL1]: { t0: REF_TOKEN, t1: USDG, r0: 999_999_999_999_999n, r1: 10_000_000_001n } });
    const ev = await run(rpc, [v2(POOL1)]);
    expect(ev?.pools[0]).toMatchObject({
      headlineUsd: "10000.000001",
      quoteAsset: USDG,
      observedBlock: "123",
      kind: "constant_product",
      valuationSource: "headline_quote_balance",
    });
    expect(evaluateLiquidity(target, ev).state).toBe("pass");
  });

  it("9999, 10000 and 10001 USD: only 10001 passes; reserve order follows token0/token1", async () => {
    for (const [raw, state] of [
      [9_999_000_000n, "fail"],
      [10_000_000_000n, "fail"],
      [10_001_000_000n, "pass"],
    ] as const) {
      const rpc = rpcFor({ [POOL1]: { t0: USDG, t1: REF_TOKEN, r0: raw, r1: 10n ** 30n } });
      expect(evaluateLiquidity(target, await run(rpc, [v2(POOL1)])).state).toBe(state);
    }
  });

  it("v3 stable quote: quote balanceOf(pool), memecoin-side balance ignored, quote not doubled", async () => {
    const rpc = rpcFor(
      { [POOL1]: { t0: REF_TOKEN, t1: USDG } },
      { [`${USDG}:${POOL1}`]: 6_000_000_000n, [`${REF_TOKEN}:${POOL1}`]: 10n ** 30n },
    );
    const ev = await run(rpc, [v3(POOL1)]);
    expect(ev?.pools[0]).toMatchObject({ kind: "concentrated", headlineUsd: "6000" });
    expect(evaluateLiquidity(target, ev).state).toBe("fail");
    expect(rpc.calls.some((c) => c.startsWith(`${REF_TOKEN}:${SEL_BALANCE_OF}`))).toBe(false);
  });

  it("v3 WETH quote priced through the configured v3 pool, both token orders, decimals 18 vs 6", async () => {
    for (const wethIsToken0 of [true, false]) {
      const rpc = rpcFor(
        { [POOL1]: { t0: REF_TOKEN, t1: WETH }, [PRICE]: priceFx(wethIsToken0) },
        {
          [`${WETH}:${POOL1}`]: 4n * E18, // 4 WETH = 12000 USD at 3000
          [`${USDG}:${PRICE}`]: 2_000_000_000_000n, // 2,000,000 USD stable side
        },
        { decimals: { [USDG]: 6, [WETH]: 18 } },
      );
      const ev = await run(rpc, [v3(POOL1)], wethCfg());
      const p = ev?.pools[0];
      expect(p?.unpriced).toBeUndefined();
      // Rounding down from the sqrt price: within 1e-6 of 12000 and never above it.
      const usd = Number(p?.headlineUsd);
      expect(usd).toBeGreaterThan(11999.99);
      expect(usd).toBeLessThanOrEqual(12000);
      expect(p?.quotePricing).toMatchObject({ pricePool: PRICE, wethIsToken0, block: "123", stableBalanceUsd: "2000000" });
      expect(evaluateLiquidity(target, ev).state).toBe("pass");
    }
  });

  it("converts WETH to stable raw units without hard-coded decimals", () => {
    expect(wethToStableRaw(E18, sqrtPrice(3000n * 10n ** 6n, E18), true)).toBeGreaterThan(2_999_999_000n);
    expect(wethToStableRaw(E18, sqrtPrice(E18, 3000n * 10n ** 6n), false)).toBeGreaterThan(2_999_999_000n);
  });

  it("WETH-quoted pool is unpriced and Pending when the price pool, floor or WETH config is unset", async () => {
    const base = { [POOL1]: { t0: REF_TOKEN, t1: WETH }, [PRICE]: priceFx(true) } as Record<string, PoolFx>;
    const bal = { [`${WETH}:${POOL1}`]: 100n * E18, [`${USDG}:${PRICE}`]: 2_000_000_000_000n };
    const cases: [WethConfig | undefined, string][] = [
      [undefined, "quote_asset_unpriced"], // WETH not configured at all: the pool is ignored
      [wethCfg({ pricePool: undefined }), "quote_asset_unpriced"],
      [wethCfg({ pricePoolMinUsd: undefined }), "price_pool_floor_unset"],
    ];
    for (const [cfg, code] of cases) {
      const ev = await run(rpcFor(base, bal, { decimals: { [USDG]: 6 } }), [v3(POOL1)], cfg);
      const r = evaluateLiquidity(target, ev);
      expect(r.state).toBe("pending");
      if (cfg) expect(r.reasons.map((x) => x.code)).toContain(code);
    }
  });

  it("price-pool floor: exactly the floor is met, one micro-dollar under is Pending", async () => {
    const mk = (stableRaw: bigint) =>
      rpcFor(
        { [POOL1]: { t0: REF_TOKEN, t1: WETH }, [PRICE]: priceFx(true) },
        { [`${WETH}:${POOL1}`]: 100n * E18, [`${USDG}:${PRICE}`]: stableRaw },
      );
    const met = evaluateLiquidity(target, await run(mk(1_000_000_000_000n), [v3(POOL1)], wethCfg()));
    expect(met.state).toBe("pass");
    const missed = await run(mk(999_999_999_999n), [v3(POOL1)], wethCfg());
    expect(missed?.pools[0]?.unpriced).toBe("price_pool_floor_not_met");
    const r = evaluateLiquidity(target, missed);
    expect(r.state).toBe("pending");
    expect(r.reasons.map((x) => x.code)).toContain("price_pool_floor_not_met");
  });

  it("price pool mismatch (wrong tokens, unlisted stable, wrong chain, zero price) is Pending", async () => {
    const bal = { [`${WETH}:${POOL1}`]: 100n * E18, [`${USDG}:${PRICE}`]: 2_000_000_000_000n };
    const poolsWith = (price: PoolFx) => ({ [POOL1]: { t0: REF_TOKEN, t1: WETH }, [PRICE]: price });
    const cases: [PoolFx, WethConfig][] = [
      [{ t0: OTHER, t1: USDG, sqrt: 1n << 96n }, wethCfg()], // no WETH in the pool
      [{ t0: WETH, t1: OTHER, sqrt: 1n << 96n }, wethCfg()], // counter-asset not on the stablecoin list
      [priceFx(true), wethCfg({ chainId: "1" })], // configured for a different chain
      [{ t0: WETH, t1: USDG, sqrt: 0n }, wethCfg()], // zero price
    ];
    for (const [price, cfg] of cases) {
      const ev = await run(rpcFor(poolsWith(price), bal), [v3(POOL1)], cfg);
      expect(ev?.pools[0]?.unpriced).toBe("price_pool_invalid");
      expect(evaluateLiquidity(target, ev).state).toBe("pending");
    }
  });

  it("fails closed when on-chain decimals disagree with the configured stablecoin list", async () => {
    const rpc = rpcFor({ [POOL1]: { t0: REF_TOKEN, t1: USDG, r1: 1n } }, {}, { decimals: { [USDG]: 18 } });
    await expect(run(rpc, [v2(POOL1)])).rejects.toThrow(/decimals/);
  });

  it("ignores pools whose quote asset is on neither list or that lack the reference token", async () => {
    const rpc = rpcFor({
      [POOL1]: { t0: REF_TOKEN, t1: OTHER, r1: 99_000_000_000n },
      [POOL2]: { t0: OTHER, t1: USDG, r1: 99_000_000_000n },
    });
    const ev = await run(rpc, [v2(POOL1), v2(POOL2)]);
    expect(ev?.pools).toHaveLength(0);
    expect(evaluateLiquidity(target, ev).state).toBe("pending");
  });

  it("counts a duplicated pool config once", async () => {
    const rpc = rpcFor({ [POOL1]: { t0: REF_TOKEN, t1: USDG, r1: 6_000_000_000n } });
    const ev = await run(rpc, [v2(POOL1), v2(POOL1.toUpperCase().replace("0X", "0x"))]);
    expect(evaluateLiquidity(target, ev).totalUsd).toBe("6000");
  });

  it("returns no evidence when the RPC serves another chain (a testnet RPC is not a reference source)", async () => {
    const rpc = rpcFor({ [POOL1]: { t0: REF_TOKEN, t1: USDG, r1: 99_000_000_000n } }, {}, { chainId: 46630n });
    expect(await run(rpc, [v2(POOL1)])).toBeNull();
    expect(rpc.calls).toHaveLength(0);
  });

  it("surfaces RPC failures instead of treating them as zero liquidity", async () => {
    await expect(run(rpcFor({}), [v2(POOL1)])).rejects.toThrow();
  });

  it("uses the block timestamp as observation time and never reads the testnet mock's pools", async () => {
    const rpc = rpcFor({ [POOL1]: { t0: REF_TOKEN, t1: USDG, r1: 20_000_000_000n } });
    const ev = await run(rpc, [v2(POOL1)]);
    expect(ev?.chainId).toBe(REF_CHAIN);
    expect(ev?.token).toBe(REF_TOKEN);
    expect(ev?.pools[0]?.observedAt).toBe(NOW.toISOString());
    const mock = rpcFor({ [POOL2]: { t0: TOKEN, t1: USDG, r1: 99_000_000_000n } });
    expect((await run(mock, [v2(POOL2)]))?.pools).toHaveLength(0);
  });

  it("shared retry wrapper retries transient failures only and keeps the pinned block", async () => {
    let n = 0;
    let seenBlock: bigint | undefined;
    const flaky = {
      chainId: async () => {
        n++;
        if (n < 3) throw new Error("EVM RPC eth_chainId failed with HTTP status 429");
        return 4663n;
      },
      blockNumber: async () => {
        throw new Error("EVM RPC eth_blockNumber error: execution reverted");
      },
      blockTimestamp: async () => 0n,
      call: async (_tx: { to: string; data: string }, block?: bigint) => {
        seenBlock = block;
        return "0x";
      },
    };
    const rpc = withEvmReadRetries(flaky, { attempts: 4, baseDelayMs: 1, maxDelayMs: 1 });
    expect(await rpc.chainId()).toBe(4663n);
    expect(n).toBe(3);
    await expect(rpc.blockNumber()).rejects.toThrow("execution reverted");
    await rpc.call({ to: POOL1, data: "0x" }, 77n);
    expect(seenBlock).toBe(77n);
  });

  it("validates the stablecoin list", () => {
    expect(() => validateStablecoins({ nope: 6 })).toThrow();
    expect(() => validateStablecoins({ [USDG]: 6.5 })).toThrow();
    expect(() => validateStablecoins({ [USDG]: 40 })).toThrow();
  });
});
