import { describe, expect, it } from "vitest";
import { loadObservationConfig } from "../../src/observations/config.js";

describe("observation config", () => {
  it("is off without a journal directory and rejects orphan settings", () => {
    expect(loadObservationConfig({})).toBeNull();
    expect(() => loadObservationConfig({ OBSERVATION_QUALIFIED_MODES: "PriceGain" })).toThrow(/OBSERVATION_JOURNAL_DIR/);
  });

  it("defaults to no qualified mode and no coverage policy", () => {
    expect(loadObservationConfig({ OBSERVATION_JOURNAL_DIR: "/data/obs" })).toEqual({ dir: "/data/obs", qualifiedModes: new Set(), coveragePolicy: null });
  });

  it("accepts price gain and drawdown, but never market cap or volume", () => {
    const base = { OBSERVATION_JOURNAL_DIR: "/d" };
    expect(loadObservationConfig({ ...base, OBSERVATION_QUALIFIED_MODES: "PriceGain, LowestDrawdown" })?.qualifiedModes).toEqual(new Set(["PriceGain", "LowestDrawdown"]));
    expect(() => loadObservationConfig({ ...base, OBSERVATION_QUALIFIED_MODES: "MarketCapGrowth" })).toThrow(/cannot enable MarketCapGrowth/);
    expect(() => loadObservationConfig({ ...base, OBSERVATION_QUALIFIED_MODES: "VolumeRatio" })).toThrow(/interval-trade/);
    expect(() => loadObservationConfig({ ...base, OBSERVATION_QUALIFIED_MODES: "Nope" })).toThrow(/unknown mode/);
  });

  it("needs tolerance and maximum gap together, within bounds", () => {
    const base = { OBSERVATION_JOURNAL_DIR: "/d" };
    expect(loadObservationConfig({ ...base, OBSERVATION_BOUNDARY_TOLERANCE_MS: "1000", OBSERVATION_MAX_GAP_MS: "12000" })?.coveragePolicy).toEqual({ boundaryToleranceMs: 1000, maxGapMs: 12000 });
    expect(() => loadObservationConfig({ ...base, OBSERVATION_MAX_GAP_MS: "12000" })).toThrow(/together/);
    expect(() => loadObservationConfig({ ...base, OBSERVATION_BOUNDARY_TOLERANCE_MS: "0", OBSERVATION_MAX_GAP_MS: "1" })).toThrow(/positive integer/);
    expect(() => loadObservationConfig({ ...base, OBSERVATION_BOUNDARY_TOLERANCE_MS: "1", OBSERVATION_MAX_GAP_MS: "86400001" })).toThrow(/at most/);
  });
});
