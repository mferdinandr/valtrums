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
  const values = series
    .filter((s) => !s.inactive)
    .flatMap((s) => {
      const last = s.points.at(-1);
      return last?.value !== null &&
        last?.value !== undefined &&
        Number.isFinite(last.value)
        ? [{ id: s.id, name: s.name, value: last.value }]
        : [];
    })
    .sort((a, b) => (a.value - b.value) * (lowerIsBetter ? 1 : -1));
  if (!values.length) return { leaders: [], gap: null };
  const best = values[0]!;
  return {
    leaders: values.filter((v) => v.value === best.value),
    gap: values.length > 1 ? Math.abs(best.value - values[1]!.value) : null,
  };
}
