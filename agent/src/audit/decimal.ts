/** Exact non-negative decimal: value = units / 10^scale. Never goes through binary floats. */
export interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** Parses plain decimal text ("0", "0.05", "10000.5"). Signs, exponents, spaces and empty text are malformed. */
export function parseDecimal(text: unknown): Decimal | null {
  if (typeof text !== "string") return null;
  const m = DECIMAL.exec(text);
  if (!m) return null;
  const frac = m[2] ?? "";
  return { units: BigInt(m[1]! + frac), scale: frac.length };
}

function rescale(d: Decimal, scale: number): bigint {
  return d.units * 10n ** BigInt(scale - d.scale);
}

export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const scale = Math.max(a.scale, b.scale);
  const x = rescale(a, scale);
  const y = rescale(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { units: rescale(a, scale) + rescale(b, scale), scale };
}

export const ZERO: Decimal = { units: 0n, scale: 0 };
export const ONE: Decimal = { units: 1n, scale: 0 };

/** Canonical text (trailing zeros trimmed) for hashing and display. */
export function formatDecimal(d: Decimal): string {
  const s = d.units.toString().padStart(d.scale + 1, "0");
  const int = s.slice(0, s.length - d.scale);
  const frac = s.slice(s.length - d.scale).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}
