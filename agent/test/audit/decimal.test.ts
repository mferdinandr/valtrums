import { describe, expect, it } from "vitest";
import { addDecimal, compareDecimal, formatDecimal, parseDecimal } from "../../src/audit/decimal.js";

describe("decimal", () => {
  it("parses exact fractions and rejects malformed text", () => {
    expect(formatDecimal(parseDecimal("0.05")!)).toBe("0.05");
    expect(formatDecimal(parseDecimal("1.000")!)).toBe("1");
    for (const bad of ["", " ", "-1", "1e3", "abc", ".5", "1.", "0x1", null, undefined, 1, "1,5"]) {
      expect(parseDecimal(bad)).toBeNull();
    }
  });

  it("compares across scales without rounding", () => {
    expect(compareDecimal(parseDecimal("10000.00")!, parseDecimal("10000")!)).toBe(0);
    expect(compareDecimal(parseDecimal("10000.000000001")!, parseDecimal("10000")!)).toBe(1);
    expect(compareDecimal(parseDecimal("9999.99")!, parseDecimal("10000")!)).toBe(-1);
  });

  it("adds exactly", () => {
    const sum = addDecimal(parseDecimal("0.1")!, parseDecimal("0.2")!);
    expect(formatDecimal(sum)).toBe("0.3");
  });
});
