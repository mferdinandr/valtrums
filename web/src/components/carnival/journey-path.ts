export type Point3 = readonly [number, number, number];
export const CHAPTERS = [
  { id: "arrival", label: "Arrival", at: 0 },
  { id: "gateway", label: "Enter", at: 0.19 },
  { id: "community", label: "Community", at: 0.32 },
  { id: "create", label: "Create", at: 0.47 },
  { id: "overlook", label: "Arena", at: 0.65 },
  { id: "vault", label: "Vault", at: 0.81 },
  { id: "events", label: "Explore", at: 1 },
] as const;
const WAYPOINTS = [
  { at: 0, camera: [0, 15, 38], look: [0, 4, -3] },
  { at: 0.15, camera: [-0.6, 5.2, 16], look: [0, 2.8, 0] },
  { at: 0.25, camera: [0.5, 4.6, 3], look: [0, 1.9, -8] },
  { at: 0.3, camera: [3.5, 6.8, -1], look: [0, 1.7, -9] },
  { at: 0.35, camera: [3.5, 6.8, -1], look: [0, 1.7, -9] },
  { at: 0.45, camera: [-6, 5.5, 0], look: [-12, 1.8, -8] },
  { at: 0.49, camera: [-6, 5.5, 0], look: [-12, 1.8, -8] },
  { at: 0.56, camera: [2, 7, 0], look: [6, 1.8, -12] },
  { at: 0.63, camera: [6, 6.6, -5], look: [11.5, 1.8, -16] },
  { at: 0.69, camera: [6, 6.6, -5], look: [11.5, 1.8, -16] },
  { at: 0.75, camera: [9, 7, -12], look: [2, 2, -25] },
  { at: 0.8, camera: [6, 6, -18], look: [1, 2, -25] },
  { at: 0.85, camera: [6, 6, -18], look: [1, 2, -25] },
  { at: 1, camera: [22, 16, 14], look: [0, 1.5, -10] },
] as const;
export const bound = (n: number) =>
  Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
export function ease(n: number) {
  const p = bound(n);
  return p * p * (3 - 2 * p);
}
export function journeyProgress(top: number, height: number, viewport: number) {
  return bound(-top / Math.max(1, height - viewport));
}
export function hostPosition(
  index: number,
  progress: number,
): [number, number, number] {
  const p = bound(progress);
  const arc = (a: number, c: number, b: number, t: number) =>
    (1 - t) ** 2 * a + 2 * (1 - t) * t * c + t * t * b;
  if (index === 0 || index === 4) {
    const dog = index === 4,
      escort = ease((p - 0.19) / 0.1),
      visit = ease((p - 0.52) / 0.1);
    const x = dog ? 4.7 : -3.6,
      z = dog ? -9.4 : -7.4;
    return [
      (dog ? 3.7 : -3.6) +
        (x - (dog ? 3.7 : -3.6)) * escort -
        x +
        arc(x, dog ? 9 : -0.5, dog ? 13.7 : 10.1, visit),
      0.08 * visit,
      (dog ? 8.6 : 9.6) +
        (z - (dog ? 8.6 : 9.6)) * escort -
        z +
        arc(z, dog ? -10 : -2.6, dog ? -14 : -13.4, visit),
    ];
  }
  if (index === 1) {
    const t = ease((p - 0.35) / 0.08);
    return [-5.2 - 3.6 * t, 0, -5.9 + 0.6 * t];
  }
  if (index === 3) {
    const t = ease((p - 0.69) / 0.09);
    const curve = (a: number, b: number, c: number, d: number) =>
      (1 - t) ** 3 * a +
      3 * (1 - t) ** 2 * t * b +
      3 * (1 - t) * t * t * c +
      t ** 3 * d;
    return [curve(-2, -10, -10, -2.7), 0, curve(-10.4, -10.4, -23, -21)];
  }
  return [3.1, 0, -7];
}
// Nonuniform cubic Hermite: shared derivatives prevent a stop at every waypoint.
// Repeated poses are deliberate overlooks with zero velocity at both ends.
function sample(p: number, key: "camera" | "look"): [number, number, number] {
  const i = Math.max(0, WAYPOINTS.findIndex((w) => w.at >= p) - 1);
  const a = WAYPOINTS[i]!,
    b = WAYPOINTS[i + 1]!,
    span = b.at - a.at;
  if (a[key].every((v, axis) => v === b[key][axis])) return [...a[key]];
  const t = bound((p - a.at) / span);
  const tangent = (index: number, axis: number) => {
    const here = WAYPOINTS[index]!,
      prev = WAYPOINTS[Math.max(0, index - 1)]!,
      next = WAYPOINTS[Math.min(WAYPOINTS.length - 1, index + 1)]!;
    if (
      (index > 0 && here[key].every((v, j) => v === prev[key][j])) ||
      (index < WAYPOINTS.length - 1 &&
        here[key].every((v, j) => v === next[key][j]))
    )
      return 0;
    if (index === 0 || index === WAYPOINTS.length - 1) return 0;
    return (next[key][axis]! - prev[key][axis]!) / (next.at - prev.at);
  };
  return a[key].map(
    (v, axis) =>
      (2 * t ** 3 - 3 * t ** 2 + 1) * v +
      (t ** 3 - 2 * t ** 2 + t) * span * tangent(i, axis) +
      (-2 * t ** 3 + 3 * t ** 2) * b[key][axis]! +
      (t ** 3 - t ** 2) * span * tangent(i + 1, axis),
  ) as [number, number, number];
}
export function settleProgress(current: number, target: number, delta: number) {
  const next =
    bound(target) +
    (bound(current) - bound(target)) *
      Math.exp(-Math.min(Math.max(delta, 0), 0.05) / 0.11);
  return Math.abs(next - target) < 0.00001 ? bound(target) : next;
}
export function journeyFrame(
  progress: number,
  portrait = false,
  reduced = false,
) {
  const p = reduced ? 0.32 : bound(progress);
  const camera = sample(p, "camera"),
    look = sample(p, "look");
  if (portrait) {
    camera[1] += 2;
    camera[2] += 5;
  }
  return { camera, look, gateOpen: ease((p - 0.04) / 0.14) };
}
export function chapterAt(p: number) {
  return p < 0.12
    ? 0
    : p < 0.25
      ? 1
      : p < 0.4
        ? 2
        : p < 0.54
          ? 3
          : p < 0.73
            ? 4
            : p < 0.89
              ? 5
              : 6;
}
export function chapterOpacity(p: number, index: number) {
  const starts = [0, 0.12, 0.25, 0.4, 0.54, 0.73, 0.89],
    ends = [0.12, 0.25, 0.4, 0.54, 0.73, 0.89, 1];
  if (chapterAt(p) !== index) return 0;
  const incoming = index === 0 ? 1 : bound((p - starts[index]!) / 0.02);
  const outgoing =
    index === CHAPTERS.length - 1 ? 1 : bound((ends[index]! - p) / 0.02);
  return Math.min(incoming, outgoing);
}
