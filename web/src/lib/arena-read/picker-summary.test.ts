import { describe, expect, it } from "vitest";
import { pickerCapacity, pickerSummary } from "./picker-summary";

describe("pickerSummary", () => {
  it("reports how many tokens exist instead of the contract limit", () => {
    expect(pickerSummary(1, 6, 2, 16)).toBe("1 chosen · 6 available · at least 2 needed");
    expect(pickerSummary(0, 6, 2, 16)).not.toMatch(/16/);
  });
  it("mentions the contract limit only when the number of tokens is unknown", () => {
    expect(pickerSummary(2, null, 2, 16)).toBe("2 chosen · up to 16 allowed · at least 2 needed");
  });
});

describe("pickerCapacity", () => {
  it("never allows more than the registered tokens or the contract limit", () => {
    expect(pickerCapacity(6, 16)).toBe(6);
    expect(pickerCapacity(40, 16)).toBe(16);
    expect(pickerCapacity(null, 16)).toBe(16);
    expect(pickerCapacity(0, 16)).toBe(0);
  });
});
