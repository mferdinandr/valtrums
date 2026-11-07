// FIXTURE-ONLY: a fake EVM RPC returns synthetic reserves. Not live chain data.
import { describe, expect, it } from "vitest";
import { goplusTarget } from "../../src/audit/decision.js";
import { evaluateLiquidity } from "../../src/audit/liquidity.js";
import { createLpFetcher, validateStablecoins } from "../../src/audit/lp-fetcher.js";
import { selector } from "../../src/evm-abi.js";
import { withEvmReadRetries } from "../../src/rpc-resilience.js";
import { NOW, REF_CHAIN, REF_TOKEN, TOKEN, asset as testnetAsset } from "./fixtures.js";

// The testnet mock is mapped to a mainnet reference; LP is always read for the reference token.
const asset = { ...testnetAsset, reference: { chainId: REF_CHAIN, token: REF_TOKEN, registryEntryHash: "h" } };
const target = goplusTarget(asset);

const USDC = "0x00000000000000000000000000000000000000c1";
const OTHER = "0x00000000000000000000000000000000000000c2";
const POOL1 = "0x00000000000000000000000000000000000000f1";
const POOL2 = "0x00000000000000000000000000000000000000f2";
const POOL3 = "0x00000000000000000000000000000000000000f3";

const w = (n: bigint) => n.toString(16).padStart(64, "0");
const a = (addr: string) => addr.slice(2).padStart(64, "0");

type PoolFixture = { t0: string; t1: string; r0?: bigint; r1?: bigint; stableBalance?: bigint };

function rpcFor(pools: Record<string, PoolFixture>, chainId = 4663n) {
  const calls: string[] = [];
  return {
    calls,
    rpc: {
      chainId: async () => chainId,
      blockNumber: async () => 123n,
      blockTimestamp: async () => BigInt(NOW.getTime() / 1000),
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
const v2 = (pool: string) => ({ pool, kind: "v2" as const });

describe("on-chain LP fetcher for the reference token (fixture-only)", () => {
  it("values only the configured stablecoin reserve and feeds the strict gate", async () => {
    const { rpc } = rpcFor({ [POOL1]: { t0: REF_TOKEN, t1: USDC, r0: 999n, r1: 10_000_000_001n } });
    const ev = await createLpFetcher({ rpc, stablecoins: stable, pools: [v2(POOL1)] })(asset);
    expect(ev?.pools[0]).toMatchObject({
      headlineUsd: "10000.000001",
      quoteAsset: USDC,
      observedBlock: "123",
      kind: "constant_product",
    });
    expect(evaluateLiquidity(target, ev).state).toBe("pass");
  });

  it("exactly 10000.000000 USDC fails; reserve order is taken from token0/token1", async () => {
    const { rpc } = rpcFor({ [POOL1]: { t0: USDC, t1: REF_TOKEN, r0: 10_000_000_000n, r1: 5n } });
    const ev = await createLpFetcher({ rpc, stablecoins: stable, pools: [v2(POOL1)] })(asset);
    const r = evaluateLiquidity(target, ev);
    expect(r.state).toBe("fail");
    expect(r.totalUsd).toBe("10000");
  });

  it("ignores pools whose quote asset is not on the stablecoin list or that lack the token", async () => {
    const { rpc } = rpcFor({
      [POOL1]: { t0: REF_TOKEN, t1: OTHER, r0: 1n, r1: 99_000_000_000n },
      [POOL2]: { t0: OTHER, t1: USDC, r0: 1n, r1: 99_000_000_000n },
    });
    const ev = await createLpFetcher({ rpc, stablecoins: stable, pools: [v2(POOL1), v2(POOL2)] })(asset);
    expect(ev?.pools).toHaveLength(0);
    expect(evaluateLiquidity(target, ev).state).toBe("pending");
  });

  it("counts a duplicated pool config once", async () => {
    const { rpc } = rpcFor({ [POOL1]: { t0: REF_TOKEN, t1: USDC, r1: 6_000_000_000n } });
    const ev = await createLpFetcher({
      rpc,
      stablecoins: stable,
      pools: [v2(POOL1), v2(POOL1.toUpperCase().replace("0X", "0x"))],
    })(asset);
    expect(evaluateLiquidity(target, ev).totalUsd).toBe("6000");
  });

  it("concentrated pools expose headline but stay pending without executable depth", async () => {
    const { rpc } = rpcFor({ [POOL3]: { t0: REF_TOKEN, t1: USDC, stableBalance: 500_000_000_000n } });
    const ev = await createLpFetcher({ rpc, stablecoins: stable, pools: [{ pool: POOL3, kind: "v3" }] })(asset);
    expect(ev?.pools[0]).toMatchObject({ kind: "concentrated", headlineUsd: "500000" });
    expect(evaluateLiquidity(target, ev).state).toBe("pending");
  });

  it("returns no evidence when the RPC serves another chain (a testnet RPC is not a reference source)", async () => {
    const testnetRpc = rpcFor({ [POOL1]: { t0: REF_TOKEN, t1: USDC, r1: 99_000_000_000n } }, 46630n);
    expect(await createLpFetcher({ rpc: testnetRpc.rpc, stablecoins: stable, pools: [v2(POOL1)] })(asset)).toBeNull();
    expect(testnetRpc.calls).toHaveLength(0);
  });

  it("surfaces RPC failures instead of treating them as zero liquidity", async () => {
    const { rpc } = rpcFor({});
    await expect(createLpFetcher({ rpc, stablecoins: stable, pools: [v2(POOL1)] })(asset)).rejects.toThrow();
  });

  it("uses the block timestamp as observation time and never reads the testnet mock's pools", async () => {
    const { rpc } = rpcFor({ [POOL1]: { t0: REF_TOKEN, t1: USDC, r1: 20_000_000_000n } });
    const ev = await createLpFetcher({ rpc, stablecoins: stable, pools: [v2(POOL1)] })(asset);
    expect(ev?.chainId).toBe(REF_CHAIN);
    expect(ev?.token).toBe(REF_TOKEN);
    expect(ev?.pools[0]?.observedAt).toBe(NOW.toISOString());
    const mock = rpcFor({ [POOL2]: { t0: TOKEN, t1: USDC, r1: 99_000_000_000n } });
    const none = await createLpFetcher({ rpc: mock.rpc, stablecoins: stable, pools: [v2(POOL2)] })(asset);
    expect(none?.pools).toHaveLength(0);
  });

  it("shared retry wrapper retries transient failures only", async () => {
    let n = 0;
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
      call: async () => "0x",
    };
    const rpc = withEvmReadRetries(flaky, { attempts: 4, baseDelayMs: 1, maxDelayMs: 1 });
    expect(await rpc.chainId()).toBe(4663n);
    expect(n).toBe(3);
    await expect(rpc.blockNumber()).rejects.toThrow("execution reverted");
  });

  it("validates the stablecoin list", () => {
    expect(() => validateStablecoins({ nope: 6 })).toThrow();
    expect(() => validateStablecoins({ [USDC]: 6.5 })).toThrow();
    expect(() => validateStablecoins({ [USDC]: 40 })).toThrow();
  });
});
