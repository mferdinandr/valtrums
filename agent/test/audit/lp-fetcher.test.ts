// FIXTURE-ONLY: a fake EVM RPC returns synthetic reserves. Not live chain data.
import { describe, expect, it } from "vitest";
import { evaluateLiquidity } from "../../src/audit/liquidity.js";
import { createLpFetcher, validateStablecoins } from "../../src/audit/lp-fetcher.js";
import { selector } from "../../src/evm-abi.js";
import { NOW, TOKEN, asset } from "./fixtures.js";

const USDC = "0x00000000000000000000000000000000000000c1";
const OTHER = "0x00000000000000000000000000000000000000c2";
const POOL1 = "0x00000000000000000000000000000000000000f1";
const POOL2 = "0x00000000000000000000000000000000000000f2";
const POOL3 = "0x00000000000000000000000000000000000000f3";

const w = (n: bigint) => n.toString(16).padStart(64, "0");
const a = (addr: string) => addr.slice(2).padStart(64, "0");

function rpcFor(
  pools: Record<string, { t0: string; t1: string; r0?: bigint; r1?: bigint; stableBalance?: bigint }>,
  chainId = 46630n,
) {
  const calls: string[] = [];
  return {
    calls,
    rpc: {
      chainId: async () => chainId,
      blockNumber: async () => 123n,
      call: async ({ to, data }: { to: string; data: string }) => {
        calls.push(`${to}:${data.slice(0, 10)}`);
        const p = pools[to];
        if (p) {
          if (data === selector("token0()")) return `0x${a(p.t0)}`;
          if (data === selector("token1()")) return `0x${a(p.t1)}`;
          if (data === selector("getReserves()")) return `0x${w(p.r0 ?? 0n)}${w(p.r1 ?? 0n)}${w(0n)}`;
        }
        // balanceOf(pool) on the stablecoin
        for (const [pool, cfg] of Object.entries(pools)) {
          if (to === USDC && data.endsWith(a(pool))) return `0x${w(cfg.stableBalance ?? 0n)}`;
        }
        throw new Error("unexpected call");
      },
    },
  };
}

const stable = validateStablecoins({ [USDC]: 6 });

describe("on-chain LP fetcher (fixture-only)", () => {
  it("values only the configured stablecoin reserve and feeds the strict gate", async () => {
    const { rpc } = rpcFor({ [POOL1]: { t0: TOKEN, t1: USDC, r0: 999n, r1: 10_000_000_001n } });
    const fetch = createLpFetcher({ rpc, stablecoins: stable, pools: [{ pool: POOL1, kind: "v2" }], now: () => NOW });
    const ev = await fetch(asset);
    expect(ev?.pools[0]).toMatchObject({ headlineUsd: "10000.000001", quoteAsset: USDC, observedBlock: "123", kind: "constant_product" });
    expect(evaluateLiquidity(asset, ev).state).toBe("pass");
  });

  it("exactly 10000.000000 USDC fails; reserve order is taken from token0/token1", async () => {
    const { rpc } = rpcFor({ [POOL1]: { t0: USDC, t1: TOKEN, r0: 10_000_000_000n, r1: 5n } });
    const fetch = createLpFetcher({ rpc, stablecoins: stable, pools: [{ pool: POOL1, kind: "v2" }], now: () => NOW });
    const r = evaluateLiquidity(asset, await fetch(asset));
    expect(r.state).toBe("fail");
    expect(r.totalUsd).toBe("10000");
  });

  it("ignores pools whose quote asset is not on the stablecoin list or that lack the token", async () => {
    const { rpc } = rpcFor({
      [POOL1]: { t0: TOKEN, t1: OTHER, r0: 1n, r1: 99_000_000_000n },
      [POOL2]: { t0: OTHER, t1: USDC, r0: 1n, r1: 99_000_000_000n },
    });
    const fetch = createLpFetcher({
      rpc,
      stablecoins: stable,
      pools: [
        { pool: POOL1, kind: "v2" },
        { pool: POOL2, kind: "v2" },
      ],
      now: () => NOW,
    });
    const ev = await fetch(asset);
    expect(ev?.pools).toHaveLength(0);
    expect(evaluateLiquidity(asset, ev).state).toBe("pending");
  });

  it("counts a duplicated pool config once", async () => {
    const { rpc } = rpcFor({ [POOL1]: { t0: TOKEN, t1: USDC, r1: 6_000_000_000n } });
    const fetch = createLpFetcher({
      rpc,
      stablecoins: stable,
      pools: [
        { pool: POOL1, kind: "v2" },
        { pool: POOL1.toUpperCase().replace("0X", "0x"), kind: "v2" },
      ],
      now: () => NOW,
    });
    const r = evaluateLiquidity(asset, await fetch(asset));
    expect(r.totalUsd).toBe("6000");
  });

  it("concentrated pools expose headline but stay pending without executable depth", async () => {
    const { rpc } = rpcFor({ [POOL3]: { t0: TOKEN, t1: USDC, stableBalance: 500_000_000_000n } });
    const fetch = createLpFetcher({ rpc, stablecoins: stable, pools: [{ pool: POOL3, kind: "v3" }], now: () => NOW });
    const ev = await fetch(asset);
    expect(ev?.pools[0]).toMatchObject({ kind: "concentrated", headlineUsd: "500000" });
    expect(evaluateLiquidity(asset, ev).state).toBe("pending");
  });

  it("returns no evidence when the RPC serves another chain, and surfaces RPC failures", async () => {
    const wrong = rpcFor({}, 4663n);
    expect(
      await createLpFetcher({ rpc: wrong.rpc, stablecoins: stable, pools: [], now: () => NOW })(asset),
    ).toBeNull();
    const { rpc } = rpcFor({});
    await expect(
      createLpFetcher({ rpc, stablecoins: stable, pools: [{ pool: POOL1, kind: "v2" }], now: () => NOW })(asset),
    ).rejects.toThrow();
  });

  it("validates the stablecoin list", () => {
    expect(() => validateStablecoins({ nope: 6 })).toThrow();
    expect(() => validateStablecoins({ [USDC]: 6.5 })).toThrow();
    expect(() => validateStablecoins({ [USDC]: 40 })).toThrow();
  });
});
