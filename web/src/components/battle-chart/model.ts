export interface ChartPoint {
  x: number;
  value: number | null;
}
export interface ChartSeries {
  id: string;
  name: string;
  color: string;
  points: ChartPoint[];
  inactive?: boolean;
}

/**
 * Each series as its distance from the average of all series at the same time. What moves every token
 * together (the shared ETH/USD price) cancels out, so only the differences between tokens remain and
 * can be magnified on their own axis. A time with fewer than two values has no average and is left out.
 */
export function relativeToField(series: readonly ChartSeries[]): ChartSeries[] {
  const at = new Map<number, number[]>();
  for (const s of series) {
    for (const p of s.points) {
      if (p.value === null || !Number.isFinite(p.value)) continue;
      at.set(p.x, [...(at.get(p.x) ?? []), p.value]);
    }
  }
  return series.map((s) => ({
    ...s,
    points: s.points.flatMap((p): ChartPoint[] => {
      if (p.value === null || !Number.isFinite(p.value)) return [p];
      const values = at.get(p.x) ?? [];
      if (values.length < 2) return [{ x: p.x, value: null }];
      return [{ x: p.x, value: p.value - values.reduce((a, b) => a + b, 0) / values.length }];
    }),
  }));
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
