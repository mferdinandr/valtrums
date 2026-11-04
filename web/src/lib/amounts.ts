// Pure helpers: amount formatting, time, performance and payout math. All integer math uses bigint.

export const USDC_DECIMALS = 6;
export const PRICE_SCALE = 10n ** 18n;
export const BPS = 10_000n;
export const CREDIT_TTL_NS = 7n * 24n * 3600n * 1_000_000_000n;
export const NS_PER_MS = 1_000_000n;

/** Profit split in percent: liquid / locked credit / burn / fee. */
export const SPLIT = { liquid: 55n, credit: 35n, burn: 5n, fee: 5n } as const;

export function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/** Parse a decimal string ("12.5") into base units. Returns null when invalid or too precise. */
export function parseUnits(input: string, decimals: number): bigint | null {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [whole = "", frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole || "0") * pow10(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Format base units as a grouped decimal string, trimmed to at most `maxFraction` digits (truncated). */
export function formatUnits(value: bigint, decimals: number, maxFraction = 2): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = pow10(decimals);
  const whole = abs / base;
  const fracFull = (abs % base).toString().padStart(decimals, "0");
  const frac = fracFull.slice(0, Math.max(0, maxFraction)).replace(/0+$/, "");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

export function formatUsdc(value: bigint, maxFraction = 2): string {
  return `$${formatUnits(value, USDC_DECIMALS, maxFraction)}`;
}

export function toBigInt(value: string | null | undefined): bigint {
  return value === null || value === undefined || value === "" ? 0n : BigInt(value);
}

/** USD value (6 decimals) of a coin amount, given its decimals and a price scaled by 1e18. */
export function coinToUsdc(amount: bigint, coinDecimals: number, priceE18: bigint): bigint {
  return (amount * priceE18 * pow10(USDC_DECIMALS)) / (pow10(coinDecimals) * PRICE_SCALE);
}

/** Coin amount (base units) worth `usdc` base units at a price scaled by 1e18. Inverse of coinToUsdc, floored. */
export function usdcToCoin(usdc: bigint, coinDecimals: number, priceE18: bigint): bigint {
  if (priceE18 <= 0n) return 0n;
  return (usdc * pow10(coinDecimals) * PRICE_SCALE) / (priceE18 * pow10(USDC_DECIMALS));
}

// ---- time ----

export function nsToMs(ns: bigint): number {
  return Number(ns / NS_PER_MS);
}

/** Milliseconds from `nowMs` until a nanosecond timestamp; negative when in the past. */
export function msUntilNs(targetNs: bigint, nowMs: number): number {
  return nsToMs(targetNs) - nowMs;
}

/** "2d 03h 04m 05s". Shows only the units that matter; "0s" at or below zero. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "0s";
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

// ---- performance ----

/** Price change in basis points, truncated toward zero. Null when the initial price is missing or zero. */
export function performanceBps(initial: bigint | null, current: bigint | null): bigint | null {
  if (initial === null || current === null || initial <= 0n) return null;
  return ((current - initial) * BPS) / initial;
}

/** "+12.34%" / "-3.00%". */
export function formatBps(bps: bigint): string {
  const negative = bps < 0n;
  const abs = negative ? -bps : bps;
  const sign = negative ? "-" : "+";
  return `${sign}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}%`;
}

/** Leader by performance. Ties (and missing data) have no leader. */
export function leader(bpsA: bigint | null, bpsB: bigint | null): "A" | "B" | null {
  if (bpsA === null || bpsB === null || bpsA === bpsB) return null;
  return bpsA > bpsB ? "A" : "B";
}

// ---- payout ----

export interface ProfitSplit {
  liquid: bigint;
  credit: bigint;
  burn: bigint;
  fee: bigint;
}

/** Split profit 55/35/5/5 with floor division; the rounding remainder goes to the fee. */
export function splitProfit(profit: bigint): ProfitSplit {
  if (profit <= 0n) return { liquid: 0n, credit: 0n, burn: 0n, fee: 0n };
  const liquid = (profit * SPLIT.liquid) / 100n;
  const credit = (profit * SPLIT.credit) / 100n;
  const burn = (profit * SPLIT.burn) / 100n;
  return { liquid, credit, burn, fee: profit - liquid - credit - burn };
}

/** A winner's pro-rata share of the loser's vault (all values in USDC base units). */
export function profitShare(deposit: bigint, winnerVault: bigint, loserVault: bigint): bigint {
  if (winnerVault <= 0n || deposit <= 0n || loserVault <= 0n) return 0n;
  return (deposit * loserVault) / winnerVault;
}

export interface PayoutPreview extends ProfitSplit {
  principal: bigint;
  profit: bigint;
  /** Principal plus the liquid profit share: what lands in the wallet right away. */
  totalLiquid: bigint;
}

/** Principal is returned 100% liquid; only the profit goes through the split. */
export function payoutPreview(principal: bigint, profit: bigint): PayoutPreview {
  const p = profit < 0n ? 0n : profit;
  const split = splitProfit(p);
  return { ...split, principal, profit: p, totalLiquid: principal + split.liquid };
}
