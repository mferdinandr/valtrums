import { describe, expect, it } from "vitest";
import {
  coinToUsdc,
  formatBps,
  formatCountdown,
  formatUnits,
  formatUsdc,
  leader,
  msUntilNs,
  parseUnits,
  payoutPreview,
  performanceBps,
  profitShare,
  splitProfit,
} from "./amounts";

describe("parseUnits / formatUnits", () => {
  it("parses decimals into base units", () => {
    expect(parseUnits("5", 6)).toBe(5_000_000n);
    expect(parseUnits("0.5", 6)).toBe(500_000n);
    expect(parseUnits(".25", 2)).toBe(25n);
    expect(parseUnits("12.", 6)).toBe(12_000_000n);
  });
  it("rejects invalid input", () => {
    expect(parseUnits("", 6)).toBeNull();
    expect(parseUnits(".", 6)).toBeNull();
    expect(parseUnits("1.2345678", 6)).toBeNull();
    expect(parseUnits("-1", 6)).toBeNull();
    expect(parseUnits("1e3", 6)).toBeNull();
  });
  it("formats with grouping and trims zeros", () => {
    expect(formatUnits(1_234_567_890n, 6)).toBe("1,234.56");
    expect(formatUnits(5_000_000n, 6)).toBe("5");
    expect(formatUnits(5_100_000n, 6)).toBe("5.1");
    expect(formatUnits(-1_500_000n, 6)).toBe("-1.5");
    expect(formatUnits(1n, 6, 6)).toBe("0.000001");
    expect(formatUsdc(30_000_000n)).toBe("$30");
  });
  it("handles 18-decimal coins", () => {
    expect(formatUnits(10n ** 18n * 3n + 5n * 10n ** 17n, 18)).toBe("3.5");
  });
});

describe("coinToUsdc", () => {
  it("converts coin units using a 1e18 price", () => {
    // 1000 coins (18 dec) at $0.002 = $2
    expect(coinToUsdc(1000n * 10n ** 18n, 18, 2n * 10n ** 15n)).toBe(2_000_000n);
    // 9-decimal coin
    expect(coinToUsdc(10n * 10n ** 9n, 9, 5n * 10n ** 17n)).toBe(5_000_000n);
  });
});

describe("countdown", () => {
  it("formats by magnitude", () => {
    expect(formatCountdown(0)).toBe("0s");
    expect(formatCountdown(-5)).toBe("0s");
    expect(formatCountdown(45_000)).toBe("45s");
    expect(formatCountdown(125_000)).toBe("2m 05s");
    expect(formatCountdown(3_725_000)).toBe("1h 02m 05s");
    expect(formatCountdown((2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000)).toBe("2d 03h 04m 05s");
  });
  it("computes ms until a ns timestamp", () => {
    expect(msUntilNs(10_000n * 1_000_000n, 4_000)).toBe(6_000);
    expect(msUntilNs(1_000n * 1_000_000n, 4_000)).toBe(-3_000);
  });
});

describe("performance", () => {
  const e = 10n ** 18n;
  it("computes basis points", () => {
    expect(performanceBps(e, (e * 11n) / 10n)).toBe(1000n);
    expect(performanceBps(e, (e * 95n) / 100n)).toBe(-500n);
    expect(performanceBps(3n, 4n)).toBe(3333n);
    expect(performanceBps(3n, 2n)).toBe(-3333n);
  });
  it("returns null without usable prices", () => {
    expect(performanceBps(null, e)).toBeNull();
    expect(performanceBps(e, null)).toBeNull();
    expect(performanceBps(0n, e)).toBeNull();
  });
  it("formats and picks leader", () => {
    expect(formatBps(1234n)).toBe("+12.34%");
    expect(formatBps(-305n)).toBe("-3.05%");
    expect(formatBps(0n)).toBe("+0.00%");
    expect(leader(100n, 50n)).toBe("A");
    expect(leader(-100n, 50n)).toBe("B");
    expect(leader(5n, 5n)).toBeNull();
    expect(leader(null, 5n)).toBeNull();
  });
});

describe("55/35/5/5 payout", () => {
  it("splits 40 USDC of profit as documented", () => {
    const s = splitProfit(40_000_000n);
    expect(s).toEqual({ liquid: 22_000_000n, credit: 14_000_000n, burn: 2_000_000n, fee: 2_000_000n });
  });
  it("floors every part and gives the remainder to the fee", () => {
    const s = splitProfit(101n);
    expect(s.liquid).toBe(55n);
    expect(s.credit).toBe(35n);
    expect(s.burn).toBe(5n);
    expect(s.fee).toBe(6n);
    expect(s.liquid + s.credit + s.burn + s.fee).toBe(101n);
    const t = splitProfit(1n);
    expect(t).toEqual({ liquid: 0n, credit: 0n, burn: 0n, fee: 1n });
  });
  it("conserves value for many amounts", () => {
    for (let p = 0n; p < 500n; p++) {
      const s = splitProfit(p);
      expect(s.liquid + s.credit + s.burn + s.fee).toBe(p);
      expect(s.fee).toBeGreaterThanOrEqual(0n);
    }
  });
  it("returns principal fully liquid and splits only profit", () => {
    const p = payoutPreview(50_000_000n, 40_000_000n);
    expect(p.principal).toBe(50_000_000n);
    expect(p.totalLiquid).toBe(72_000_000n);
    expect(p.credit).toBe(14_000_000n);
    expect(p.burn).toBe(2_000_000n);
    expect(p.fee).toBe(2_000_000n);
  });
  it("pays no profit shares when profit is zero", () => {
    const p = payoutPreview(10n, 0n);
    expect(p.totalLiquid).toBe(10n);
    expect(p.credit + p.burn + p.fee).toBe(0n);
  });
  it("computes pro-rata profit share", () => {
    expect(profitShare(50n, 100n, 80n)).toBe(40n);
    expect(profitShare(50n, 0n, 80n)).toBe(0n);
    expect(profitShare(50n, 100n, 0n)).toBe(0n);
  });
});
