import { describe, expect, it } from "vitest";
import { checkFundAmount } from "./balance";

describe("checkFundAmount", () => {
  it("parses a valid amount into USDC base units", () => {
    expect(checkFundAmount("25", 100_000_000n)).toEqual({ ok: true, units: 25_000_000n });
    expect(checkFundAmount("0.5", 100_000_000n)).toEqual({ ok: true, units: 500_000n });
  });

  it("rejects bad input, zero and more than the wallet holds", () => {
    expect(checkFundAmount("abc", 100n).ok).toBe(false);
    expect(checkFundAmount("1.1234567", 100_000_000n).ok).toBe(false);
    expect(checkFundAmount("0", 100_000_000n).ok).toBe(false);
    const over = checkFundAmount("101", 100_000_000n);
    expect(over).toMatchObject({ ok: false });
    expect(over.ok === false && over.error).toContain("$100");
  });
});
