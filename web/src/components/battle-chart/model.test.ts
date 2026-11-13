import { describe, expect, it } from "vitest";
import { clipToPlayhead } from "./model";
import { playbackLag } from "./chart";

describe("playbackLag", () => {
  it("covers the widest recent gap between samples, within bounds", () => {
    expect(playbackLag([0, 1, 2, 3])).toBeCloseTo(1.6);
    expect(playbackLag([0, 1, 4, 5])).toBeCloseTo(3.6);
    expect(playbackLag([0, 0.2, 0.4])).toBe(1.2);
    expect(playbackLag([0, 10])).toBe(4.5);
    expect(playbackLag([])).toBe(1.2);
  });
});

describe("clipToPlayhead", () => {
  const points = [
    { x: 0, value: 0 },
    { x: 1, value: 2 },
    { x: 2, value: 4 },
  ];

  it("keeps recorded points before the playhead and adds one point on the line to the next sample", () => {
    expect(clipToPlayhead(points, 1.5)).toEqual([
      { x: 0, value: 0 },
      { x: 1, value: 2 },
      { x: 1.5, value: 3 },
    ]);
  });

  it("never draws past the newest recorded point", () => {
    expect(clipToPlayhead(points, 5)).toEqual(points);
  });

  it("does not bridge a gap in the evidence", () => {
    const gapped = [{ x: 0, value: 1 }, { x: 1, value: null }, { x: 2, value: 3 }];
    expect(clipToPlayhead(gapped, 1.5)).toEqual([{ x: 0, value: 1 }, { x: 1, value: null }]);
  });

  it("draws nothing before the first sample", () => {
    expect(clipToPlayhead([{ x: 1, value: 1 }], 0.5)).toEqual([]);
  });
});
