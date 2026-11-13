import { describe, expect, it } from "vitest";
import { clipToPlayhead, smoothPath, type PlotPoint } from "./model";

/** Samples a cubic Bezier path string "M x,y C ... C ..." into points, for checking its shape. */
function samplePath(d: string): PlotPoint[] {
  const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
  let p = { x: nums[0]!, y: nums[1]! };
  const out = [p];
  for (let i = 2; i + 5 < nums.length; i += 6) {
    const [c1x, c1y, c2x, c2y, ex, ey] = nums.slice(i, i + 6) as [number, number, number, number, number, number];
    for (let k = 1; k <= 20; k++) {
      const t = k / 20, u = 1 - t;
      out.push({
        x: u ** 3 * p.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t ** 3 * ex,
        y: u ** 3 * p.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t ** 3 * ey,
      });
    }
    p = { x: ex, y: ey };
  }
  return out;
}

describe("smoothPath", () => {
  const pts = [{ x: 0, y: 100 }, { x: 10, y: 20 }, { x: 20, y: 60 }, { x: 30, y: 60 }, { x: 40, y: 0 }];

  it("passes through every sample and never goes beyond the samples on either side", () => {
    const { d, end } = smoothPath(pts)!;
    expect(end).toEqual(pts.at(-1));
    for (const p of pts) expect(d).toContain(`${p.x},${p.y}`);
    const curve = samplePath(d);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!, b = pts[i + 1]!;
      const lo = Math.min(a.y, b.y) - 0.01, hi = Math.max(a.y, b.y) + 0.01;
      for (const q of curve.filter((q) => q.x > a.x && q.x < b.x)) {
        expect(q.y).toBeGreaterThanOrEqual(lo);
        expect(q.y).toBeLessThanOrEqual(hi);
      }
    }
    // A flat stretch stays flat.
    for (const q of curve.filter((q) => q.x > 20 && q.x < 30)) expect(q.y).toBeCloseTo(60, 1);
  });

  it("stops exactly at the cut, on the same curve the full path draws", () => {
    const full = samplePath(smoothPath(pts)!.d);
    const cut = smoothPath(pts, 15)!;
    expect(cut.end.x).toBeCloseTo(15, 6);
    const onFull = full.reduce((best, q) => (Math.abs(q.x - 15) < Math.abs(best.x - 15) ? q : best));
    expect(cut.end.y).toBeCloseTo(onFull.y, 0);
    expect(smoothPath(pts, -1)).toBeNull();
  });
});
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
