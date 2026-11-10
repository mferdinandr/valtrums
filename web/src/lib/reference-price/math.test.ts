import { describe, expect, it } from "vitest";
import { percentFrom, tokenPriceInWeth } from "./math";

const Q96 = 2n ** 96n;

describe("tokenPriceInWeth", () => {
  it("reads token0 priced in token1 when the token is token0", () => {
    // sqrtPrice = 2 * 2^96 means token0 is worth 4 token1 at equal decimals.
    expect(tokenPriceInWeth(2n * Q96, false, 18, 18)).toBeCloseTo(4, 9);
  });

  it("inverts the price when token0 is WETH", () => {
    expect(tokenPriceInWeth(2n * Q96, true, 18, 18)).toBeCloseTo(0.25, 9);
  });

  it("adjusts for different decimals", () => {
    // Raw ratio 1 with 6 vs 18 decimals: 10^(6-18) token1 per token0.
    expect(tokenPriceInWeth(Q96, false, 6, 18)).toBeCloseTo(1e-12, 20);
  });

  it("returns null for an empty or invalid pool", () => {
    expect(tokenPriceInWeth(0n, false, 18, 18)).toBeNull();
    expect(tokenPriceInWeth(Q96, false, 18, 99)).toBeNull();
    expect(tokenPriceInWeth(Q96, false, 1.5, 18)).toBeNull();
  });
});

describe("percentFrom", () => {
  it("measures the change from the first price", () => {
    expect(percentFrom(100, 110)).toBeCloseTo(10);
    expect(percentFrom(100, 90)).toBeCloseTo(-10);
  });

  it("refuses a missing or non-positive base", () => {
    expect(percentFrom(0, 1)).toBeNull();
    expect(percentFrom(Number.NaN, 1)).toBeNull();
  });
});
