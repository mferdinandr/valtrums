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

  it("counts concentrated pools by executable depth, not headline", () => {
    expect(evaluateLiquidity(a, lp("500000", { kind: "concentrated" })).state).toBe("pending");
    const r = evaluateLiquidity(a, lp("500000", { kind: "concentrated", executableDepthUsd: "9000" }));
    expect(r.state).toBe("fail");
    expect(r.headlineUsd).toBe("500000");
    expect(evaluateLiquidity(a, lp("500000", { kind: "concentrated", executableDepthUsd: "10001" })).state).toBe(
      "pass",
    );
  });
});
