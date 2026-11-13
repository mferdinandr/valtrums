export interface ChartPoint {
  x: number;
  value: number | null;
  /**
   * The same value as an exact integer in units of 1e-18 percentage points, when the source computed it
   * exactly. Differences between tokens are then taken without floating-point rounding.
   */
  exact?: bigint;
}
export interface ChartSeries {
  id: string;
  name: string;
  color: string;
  points: ChartPoint[];
  inactive?: boolean;
}

/** Units of `ChartPoint.exact` per percentage point. */
export const EXACT_SCALE = 10n ** 18n;

/**
 * Each series as how far it trails the leader at the same time: the leader is 0 and every other token is
 * negative by its gap. What moves every token together (the shared ETH/USD price) cancels out, so only
 * the differences between tokens remain and can be magnified on their own axis. Unlike a gap from the
 * average, two tokens are not drawn as mirror images. With `lowerIsBetter` the lowest score leads. A
 * time with fewer than two values has no leader and is left out. When every value at a time carries an
 * exact integer, the gap is computed in integers, so differences in the 13th or 14th decimal are kept
 * instead of lost to floating-point rounding.
 */
export function relativeToLeader(series: readonly ChartSeries[], lowerIsBetter = false): ChartSeries[] {
  const at = new Map<number, ChartPoint[]>();
  for (const s of series) {
    for (const p of s.points) {
      if (p.value === null || !Number.isFinite(p.value)) continue;
      at.set(p.x, [...(at.get(p.x) ?? []), p]);
    }
  }
  return series.map((s) => ({
    ...s,
    points: s.points.flatMap((p): ChartPoint[] => {
      if (p.value === null || !Number.isFinite(p.value)) return [p];
      const field = at.get(p.x) ?? [];
      if (field.length < 2) return [{ x: p.x, value: null }];
      if (p.exact !== undefined && field.every((q) => q.exact !== undefined)) {
        const exacts = field.map((q) => q.exact!);
        const leader = exacts.reduce((a, b) => (lowerIsBetter ? (b < a ? b : a) : b > a ? b : a));
        const gap = lowerIsBetter ? leader - p.exact : p.exact - leader;
        return [{ x: p.x, value: Number(gap) / Number(EXACT_SCALE), exact: gap }];
      }
      const values = field.map((q) => q.value!);
      const leader = lowerIsBetter ? Math.min(...values) : Math.max(...values);
      return [{ x: p.x, value: lowerIsBetter ? leader - p.value : p.value - leader }];
    }),
  }));
}

/**
 * Whether the tokens' scores differ anywhere in the plotted samples. With exact values any real
 * difference counts, however small; float-only values must differ by at least `floatFloor`.
 */
export function scoresDiffer(field: readonly ChartSeries[], floatFloor: number): boolean {
  const points = field.flatMap((s) => s.points.filter((p) => p.value !== null && Number.isFinite(p.value)));
  if (points.length === 0) return false;
  if (points.every((p) => p.exact !== undefined)) return points.some((p) => p.exact !== 0n);
  const values = points.map((p) => p.value!);
  return Math.max(...values) - Math.min(...values) >= floatFloor;
}

/**
 * The points drawn up to `playhead` (round seconds): every recorded point at or before it, then, if a later
 * recorded point follows in the same unbroken segment, one point at the playhead on the straight line
 * between those two real samples. Nothing is drawn past the newest recorded point. Display-only geometry.
 */
export function clipToPlayhead(points: readonly ChartPoint[], playhead: number): ChartPoint[] {
  const out: ChartPoint[] = [];
  for (const p of points) {
    if (p.x <= playhead) {
      out.push(p);
      continue;
    }
    const prev = out.at(-1);
    if (prev && prev.value !== null && Number.isFinite(prev.value) && p.value !== null && Number.isFinite(p.value) && p.x > prev.x) {
      const f = (playhead - prev.x) / (p.x - prev.x);
      if (f > 0) out.push({ x: playhead, value: prev.value + (p.value - prev.value) * f });
    }
    break;
  }
  return out;
}

/** A point in drawing (pixel) coordinates. */
export interface PlotPoint {
  x: number;
  y: number;
}

/**
 * A smooth SVG path through `pts` (sorted by x), cut at `cutX`. It uses monotone cubic interpolation
 * (Fritsch-Carlson, as d3's curveMonotoneX): the curve passes exactly through every point and never
 * overshoots between two of them, so it shows no peak or dip the data does not have. Between two points
 * the curve's x advances linearly with the curve parameter, so the cut is an exact split of that piece.
 * Returns the path and where it ends (the moving head), or null when no point is at or before `cutX`.
 * Display-only geometry.
 */
export function smoothPath(pts: readonly PlotPoint[], cutX = Infinity): { d: string; end: PlotPoint } | null {
  const n = pts.length;
  if (n === 0 || pts[0]!.x > cutX) return null;
  const f = (v: number) => (Math.round(v * 100) / 100).toString();
  if (n === 1) return { d: `M${f(pts[0]!.x)},${f(pts[0]!.y)}`, end: pts[0]! };
  const slope = (i: number) => {
    const h = pts[i + 1]!.x - pts[i]!.x;
    return h > 0 ? (pts[i + 1]!.y - pts[i]!.y) / h : 0;
  };
  const tangents = pts.map((_, i) => {
    if (i === 0) return slope(0);
    if (i === n - 1) return slope(n - 2);
    const s0 = slope(i - 1), s1 = slope(i);
    const h0 = pts[i]!.x - pts[i - 1]!.x, h1 = pts[i + 1]!.x - pts[i]!.x;
    const p = h0 + h1 > 0 ? (s0 * h1 + s1 * h0) / (h0 + h1) : 0;
    return (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  });
  let d = `M${f(pts[0]!.x)},${f(pts[0]!.y)}`;
  let end: PlotPoint = pts[0]!;
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    if (a.x >= cutX) break;
    const h = b.x - a.x;
    // Cubic Bezier control points of the Hermite piece.
    const c1 = { x: a.x + h / 3, y: a.y + (tangents[i]! * h) / 3 };
    const c2 = { x: b.x - h / 3, y: b.y - (tangents[i + 1]! * h) / 3 };
    if (b.x <= cutX) {
      d += `C${f(c1.x)},${f(c1.y)} ${f(c2.x)},${f(c2.y)} ${f(b.x)},${f(b.y)}`;
      end = b;
      continue;
    }
    // Split the piece at the cut (de Casteljau) and draw only its first part.
    const t = h > 0 ? (cutX - a.x) / h : 0;
    const lerp = (p: PlotPoint, q: PlotPoint) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    const p01 = lerp(a, c1), p12 = lerp(c1, c2), p23 = lerp(c2, b);
    const p012 = lerp(p01, p12), p123 = lerp(p12, p23);
    const head = lerp(p012, p123);
    d += `C${f(p01.x)},${f(p01.y)} ${f(p012.x)},${f(p012.y)} ${f(head.x)},${f(head.y)}`;
    end = head;
    break;
  }
  return { d, end };
}

/** Display-only geometry. Never use floating-point chart values to settle a battle. */
export function chartSegments(points: readonly ChartPoint[]) {
  const segments: ChartPoint[][] = [];
  let current: ChartPoint[] = [];
  for (const point of points) {
    if (
      point.value === null ||
      !Number.isFinite(point.value) ||
      !Number.isFinite(point.x)
    ) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}
export function displayStandings(
  series: readonly ChartSeries[],
  lowerIsBetter: boolean,
) {
  const active = series.filter((s) => !s.inactive);
  const latest = active.map((s) => ({
    series: s,
    point: s.points.findLast((p) => p.value !== null && Number.isFinite(p.value)),
  }));
  // Never compare one token's new observation against another token's older one.
  if (latest.length < 2 || latest.some(({ point }) => !point) || latest.some(({ point }) => point!.x !== latest[0]!.point!.x)) {
    return { leaders: [], gap: null };
  }
  const values = latest
    .map(({ series: s, point }) => ({ id: s.id, name: s.name, value: point!.value! }))
    .sort((a, b) => (a.value - b.value) * (lowerIsBetter ? 1 : -1));
  if (!values.length) return { leaders: [], gap: null };
  const best = values[0]!;
  return {
    leaders: values.filter((v) => v.value === best.value),
    gap: values.length > 1 ? Math.abs(best.value - values[1]!.value) : null,
  };
}
