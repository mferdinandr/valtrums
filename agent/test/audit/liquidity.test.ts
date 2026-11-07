// FIXTURE-ONLY: values are synthetic, not market liquidity.
import { describe, expect, it } from "vitest";
import { evaluateLiquidity } from "../../src/audit/liquidity.js";
import { CHAIN, TOKEN, lp } from "./fixtures.js";

const a = { chainId: CHAIN, token: TOKEN };

describe("independent liquidity gate (fixture-only)", () => {
  it("9999 and 10000 fail, 10001 passes", () => {
    expect(evaluateLiquidity(a, lp("9999")).state).toBe("fail");
    expect(evaluateLiquidity(a, lp("10000")).state).toBe("fail");
    expect(evaluateLiquidity(a, lp("10000.00")).state).toBe("fail");
    expect(evaluateLiquidity(a, lp("10001")).state).toBe("pass");
    expect(evaluateLiquidity(a, lp("10000.000001")).state).toBe("pass");
  });

  it("absent evidence is pending", () => {
    expect(evaluateLiquidity(a, null).state).toBe("pending");
    expect(evaluateLiquidity(a, { chainId: CHAIN, token: TOKEN, pools: [] }).state).toBe("pending");
  });

  it("counts duplicate pools once", () => {
    const e = lp("6000");
    e.pools.push({ ...e.pools[0]!, poolId: "0xPOOL1" });
    const r = evaluateLiquidity(a, e);
    expect(r.totalUsd).toBe("6000");
    expect(r.state).toBe("fail");
    expect(r.reasons.some((x) => x.code === "duplicate_pool")).toBe(true);
  });

  it("conflicting duplicates are pending", () => {
    const e = lp("6000");
    e.pools.push({ ...e.pools[0]!, headlineUsd: "999999" });
    expect(evaluateLiquidity(a, e).state).toBe("pending");
  });

  it("sums distinct pools exactly", () => {
    const e = lp("5000");
    e.pools.push({ ...e.pools[0]!, poolId: "0xpool2", headlineUsd: "5000.5" });
    expect(evaluateLiquidity(a, e).state).toBe("pass");
  });

  it("rejects evidence or pools for another asset", () => {
    expect(evaluateLiquidity(a, { ...lp("50000"), chainId: "4663" }).state).toBe("pending");
    const e = lp("50000");
    e.pools[0]!.token = "0x00000000000000000000000000000000000000bb";
    const r = evaluateLiquidity(a, e);
    expect(r.state).toBe("pending");
    expect(r.reasons.some((x) => x.code === "mismatched_asset")).toBe(true);
  });

  it("holds pending without valuation source, observation or parsable value", () => {
    expect(evaluateLiquidity(a, lp("50000", { valuationSource: null })).state).toBe("pending");
    expect(evaluateLiquidity(a, lp("50000", { observedAt: null, observedBlock: null })).state).toBe("pending");
    expect(evaluateLiquidity(a, lp("lots")).state).toBe("pending");
    expect(evaluateLiquidity(a, lp("50000", { observedAt: "garbage", observedBlock: null })).state).toBe("pending");
  });

  it("values v2 and v3 pools alike by their quote-side headline balance", () => {
    expect(evaluateLiquidity(a, lp("10001", { kind: "concentrated" })).state).toBe("pass");
    expect(evaluateLiquidity(a, lp("10000", { kind: "concentrated" })).state).toBe("fail");
    expect(evaluateLiquidity(a, lp("10001", { kind: "constant_product" })).state).toBe("pass");
  });

  it("requires the headline_quote_balance valuation source", () => {
    expect(evaluateLiquidity(a, lp("50000", { valuationSource: "executable_depth" })).state).toBe("pending");
  });

  it("an unpriced pool is not counted: only-unpriced is Pending with its reason", () => {
    for (const code of [
      "quote_asset_unpriced",
      "price_pool_floor_unset",
      "price_pool_floor_not_met",
      "price_pool_invalid",
    ] as const) {
      const r = evaluateLiquidity(a, lp("0", { headlineUsd: null, unpriced: code }));
      expect(r.state).toBe("pending");
      expect(r.reasons.map((x) => x.code)).toContain(code);
    }
  });

  it("counted liquidity above the threshold passes despite an unpriced pool; at or below it holds Pending, not Fail", () => {
    const mk = (usd: string) => {
      const e = lp(usd);
      e.pools.push({ ...e.pools[0]!, poolId: "0xpool2", headlineUsd: null, unpriced: "quote_asset_unpriced" });
      return e;
    };
    expect(evaluateLiquidity(a, mk("10001")).state).toBe("pass");
    expect(evaluateLiquidity(a, mk("10000")).state).toBe("pending");
    expect(evaluateLiquidity(a, mk("9999")).state).toBe("pending");
  });
});
