// FIXTURE-ONLY: synthetic evidence payloads. Not provider data.
import { describe, expect, it } from "vitest";
import { chartSegments } from "./model";
import { exactScoreText, observationSeries } from "./observation-series";
import type { ObservationData, ObservationItem } from "@/lib/arena-read/observations";

const START_MS = 1_000_000n;
const item = (community: number, atMs: bigint | null, price: string, mode: ObservationItem["mode"] = "PriceGain"): ObservationItem => ({
  seq: "1", id: `${community}-${atMs}-${price}`, battleId: "1", roundId: "1", community, mode, policyHash: "p",
  source: { name: "s", kind: "fixture", pool: null, quote: "USD" }, inputs: { kind: "price", price, priceScale: 8 },
  evidenceHash: "e", observedAtMs: atMs === null ? null : atMs.toString(), acquiredAtMs: "1",
});
const cov = (community: number, over: Partial<NonNullable<ObservationData["coverage"]>["communities"][number]> = {}) => ({
  community, samples: 0, unknownTime: 0, hasStart: true, hasEnd: true, gaps: [], firstObservedAtMs: null, lastObservedAtMs: null, complete: true, ...over,
});
const data = (items: ObservationItem[], communities = [cov(0), cov(1)], over: Partial<ObservationData> = {}): ObservationData => ({
  battleId: "1", sourceKind: "fixture", sourceKinds: ["fixture"], items, nextCursor: null, truncated: false, revision: "0", retractedSinceCursor: [],
  recorded: { roundId: "1", winner: null, candidates: [0, 1], startNs: (START_MS * 1_000_000n).toString(), endNs: ((START_MS + 30_000n) * 1_000_000n).toString() },
  coverage: { watermark: { seq: 1, headHash: "h" }, revision: 0, foreign: 0, communities }, projection: null, ...over,
});

describe("observation chart adapter", () => {
  it("plots percent change from the start sample at its provider time, without interpolation", () => {
    const m = observationSeries(data([item(0, START_MS, "300"), item(0, START_MS + 15_000n, "310"), item(1, START_MS, "200")]));
    expect(m.drawable).toBe(true);
    expect(m.duration).toBe(30);
    expect(m.series[0]!.points).toEqual([{ x: 0, value: 0 }, { x: 15, value: 3.33 }]);
    expect(m.series[1]!.points).toEqual([{ x: 0, value: 0 }]);
  });

  it("leaves a null endpoint when the close is missing, so the line breaks instead of extending", () => {
    const m = observationSeries(data([item(0, START_MS, "100"), item(0, START_MS + 10_000n, "110")], [cov(0, { hasEnd: false, complete: false }), cov(1)]));
    expect(m.series[0]!.points.at(-1)).toEqual({ x: 30, value: null });
    expect(chartSegments(m.series[0]!.points)).toHaveLength(1);
    expect(m.gapNotes.join(" ")).toMatch(/community 1: no closing sample/);
  });

  it("breaks the line across a reported coverage gap", () => {
    const a = START_MS, b = START_MS + 20_000n;
    const m = observationSeries(data([item(0, a, "100"), item(0, b, "120")], [cov(0, { gaps: [{ fromMs: a.toString(), toMs: b.toString() }], complete: false }), cov(1)]));
    expect(chartSegments(m.series[0]!.points)).toHaveLength(2);
    expect(m.gapNotes.join(" ")).toMatch(/1 gap/);
  });

  it("has no baseline, and so no values, when the start sample is missing", () => {
    const m = observationSeries(data([item(0, START_MS + 10_000n, "100"), item(0, START_MS + 20_000n, "120")], [cov(0, { hasStart: false, complete: false }), cov(1)]));
    expect(m.series[0]!.points.every((p) => p.value === null)).toBe(true);
  });

  it("does not plot samples without a provider time and says so", () => {
    const m = observationSeries(data([item(0, null, "100"), item(0, START_MS, "100")], [cov(0, { unknownTime: 1 }), cov(1)]));
    expect(m.series[0]!.points).toHaveLength(1);
    expect(m.gapNotes.join(" ")).toMatch(/1 sample\(s\) without a provider time/);
  });

  it("plots running drawdown for the drawdown mode and marks lower as better", () => {
    const m = observationSeries(data([item(0, START_MS, "100", "LowestDrawdown"), item(0, START_MS + 10_000n, "80", "LowestDrawdown"), item(0, START_MS + 20_000n, "100", "LowestDrawdown")]));
    expect(m.lowerIsBetter).toBe(true);
    expect(m.series[0]!.points.map((p) => p.value)).toEqual([0, 20, 0]);
  });

  it("draws nothing for modes the evidence cannot support, and never invents a baseline when the window is unknown", () => {
    const cap = observationSeries(data([], [], { projection: { status: "unavailable", authoritative: false, mode: "MarketCapGrowth", reasons: ["x"], scores: [], provisionalLeaders: [] } }));
    expect(cap).toMatchObject({ drawable: false, series: [] });
    const noWindow = observationSeries(data([item(0, START_MS, "100")], [cov(0)], { recorded: null }));
    expect(noWindow.series).toEqual([]);
  });

  it("shows exact scores as untouched fractions, not rounded labels", () => {
    expect(exactScoreText({ negative: false, numerator: "1", denominator: "30000000" })).toBe("+1/30000000");
    expect(exactScoreText({ negative: true, numerator: "10", denominator: "200" })).toBe("-10/200");
  });
});
