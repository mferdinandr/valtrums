/**
 * Where each contender stands on the arc behind the welcome square. Positions are computed from the number of
 * contenders, never listed by hand, so adding or hiding a character in the registry cannot leave a contender
 * without a position (that used to crash the whole 3D scene).
 */
export function contenderPositions(count: number): [number, number, number][] {
  if (!Number.isInteger(count) || count < 1) return [];
  if (count === 1) return [[0, 2.77, -16]];
  return Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    const x = -7 + 14 * t;
    // A shallow arc: the ends sit at z=-8 and the middle at z=-16.
    const z = -8 - 8 * (1 - (2 * t - 1) ** 2);
    return [Number(x.toFixed(3)), 2.77, Number(z.toFixed(3))];
  });
}
