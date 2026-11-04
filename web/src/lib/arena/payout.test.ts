import { describe, expect, it } from "vitest";
import { previewClaim } from "./payout";
import { splitProfit } from "../amounts";

const position = { side: "A" as const, coin_amount: "100", usdc_equiv: "0", from_credit: "0", claimed: false };
const base = { position, winnerVaultCoin: 400n, winnerDecimals: 6, winnerPrice: 10n ** 18n, loserVaultUsdc: 1_000n, plan: null };

describe("previewClaim", () => {
  it("shares each pool by the position's share of the winner vault", () => {
    const p = previewClaim(base);
    const pool = splitProfit(1_000n);
    expect(p.estimated).toBe(true);
    expect(p.credit).toBe((pool.credit * 100n) / 400n);
    expect(p.principalCoin).toBe(100n);
    // price 1.0 and 6 decimals: one USDC unit buys one coin unit.
    expect(p.rewardCoin).toBe((pool.liquid * 100n) / 400n);
    expect(p.totalCoin).toBe(100n + p.rewardCoin);
  });

  it("uses reported dump and buy steps once available", () => {
    const p = previewClaim({
      ...base,
      plan: [
        { index: 0, kind: "Dump", amount: "1000", done: true, realized: "2000" },
        { index: 1, kind: "Buy", amount: "1100", done: true, realized: "800" },
        { index: 2, kind: "Burn", amount: "100", done: false, realized: null },
        { index: 3, kind: "Return", amount: "100", done: false, realized: null },
      ],
    });
    expect(p.estimated).toBe(false);
    expect(p.dumpProceeds).toBe(2000n);
    expect(p.rewardCoin).toBe(200n);
    expect(p.credit).toBe((700n * 100n) / 400n);
  });

  it("pays nothing extra when the winner vault is empty", () => {
    expect(previewClaim({ ...base, winnerVaultCoin: 0n }).totalCoin).toBe(100n);
  });
});
