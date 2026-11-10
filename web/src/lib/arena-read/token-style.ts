import type { TokenLabel } from "./lifecycle";

/** Vivid UI accents per token. Cosmetic only; the 3D model colors are separate. */
const ACCENTS: Readonly<Record<string, string>> = {
  CASHCAT: "#ff7a59",
  WALLET: "#2f80ff",
  GOOD: "#2fbf71",
  AI: "#8b5cf6",
  VLAD: "#e0457b",
  DEGEN: "#f2b01e",
};
const FALLBACK = ["#14b8a6", "#f97316", "#6366f1", "#ec4899", "#84cc16", "#0ea5e9"];

/**
 * The name to show. A testnet mock is stored as `mDEGEN`; the people-facing name is `DEGEN`, and the page marks
 * testnet separately so a mock is never mistaken for the real token. The identity is still chain + address.
 */
export function displaySymbol(label: Pick<TokenLabel, "symbol" | "kind"> | null | undefined, fallback: string): string {
  if (!label) return fallback;
  if (label.kind === "testnet-mock" && /^m[A-Z0-9]/.test(label.symbol)) return label.symbol.slice(1);
  return label.symbol;
}

/** A stable accent for a symbol: the curated one, or one derived from the text so it never changes between renders. */
export function accentFor(symbol: string): string {
  const key = symbol.toUpperCase();
  const known = ACCENTS[key];
  if (known) return known;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK[h % FALLBACK.length]!;
}

/** One or two letters for the monogram shown when a token has no logo or its image fails. */
export function monogram(symbol: string): string {
  const letters = symbol.replace(/[^A-Za-z0-9]/g, "");
  return (letters.slice(0, 2) || "?").toUpperCase();
}
