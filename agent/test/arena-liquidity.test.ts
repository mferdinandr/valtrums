import { describe, expect, it } from "vitest";
import { inspectLiquidity, type LiquidityEvidence } from "../src/arena-liquidity.js";

const asset = { chainId: "46630", token: "0xabc", representation: "token.testnet", custodyDomain: "custody", mappingVersion: "1" };
const evidence: LiquidityEvidence = { asset, source: "fixture-pool", poolIds: ["pool"], quoteAsset: "USD", valuationSource: "fixture", observedAt: "time", blockReference: "block", usdValue: "10000", kind: "fixture" };

describe("independent liquidity threshold", () => {
  it("uses a strict exact decimal comparison", () => {
    expect(inspectLiquidity(asset, { ...evidence, usdValue: "9999" }).decision).toBe("Reject");
    expect(inspectLiquidity(asset, evidence).decision).toBe("Reject");
    expect(inspectLiquidity(asset, { ...evidence, usdValue: "10000.000000000000000001" }).decision).toBe("Pass");
  });
  it("holds missing, malformed, duplicate and wrong-asset evidence pending", () => {
    expect(inspectLiquidity(asset).decision).toBe("Pending");
    expect(inspectLiquidity(asset, { ...evidence, usdValue: "NaN" }).decision).toBe("Pending");
    expect(inspectLiquidity(asset, { ...evidence, poolIds: ["pool", "pool"] }).decision).toBe("Pending");
    expect(inspectLiquidity({ ...asset, mappingVersion: "2" }, evidence).decision).toBe("Pending");
  });
});
