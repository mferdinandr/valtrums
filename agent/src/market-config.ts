import { MIN_LIQUIDITY_USD } from "./auditor.js";
import { TWAP_WINDOW_MS } from "./twap.js";

export type MarketData = "dexscreener" | "mockdex" | "ref";

export interface MarketConfig {
  marketData: MarketData;
  /** TWAP window in seconds. */
  twapWindowSecs: number;
  /** An audited token needs more than this much liquidity, in whole USD. */
  minLiquidityUsd: number;
  /** Exchange whose pools serve as market data. Set when `marketData` is "ref". */
  refExchangeId?: string;
}

export const MIN_TWAP_WINDOW_SECS = 30;
export const MAX_TWAP_WINDOW_SECS = 7 * 24 * 3600;
export const MAX_MIN_LIQUIDITY_USD = 1_000_000_000_000;

function boundedInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return n;
}

/**
 * Market data settings. `intervalSecs` is the pass interval (which is also the
 * price sampling interval): the TWAP window must hold at least two samples, so
 * it may not be shorter than twice the interval.
 */
export function loadMarketConfig(
  env: Record<string, string | undefined>,
  intervalSecs: number,
): MarketConfig {
  const source = env.MARKET_DATA?.trim() || "dexscreener";
  if (source !== "dexscreener" && source !== "mockdex" && source !== "ref") {
    throw new Error(`MARKET_DATA must be "dexscreener", "mockdex" or "ref"`);
  }
  const refExchangeId = env.REF_EXCHANGE_ID?.trim() || undefined;
  if (source === "ref" && !refExchangeId) {
    throw new Error("MARKET_DATA=ref needs REF_EXCHANGE_ID (the exchange contract account)");
  }
  const twapWindowSecs = boundedInt(
    env,
    "TWAP_WINDOW_SECS",
    TWAP_WINDOW_MS / 1000,
    MIN_TWAP_WINDOW_SECS,
    MAX_TWAP_WINDOW_SECS,
  );
  if (twapWindowSecs < 2 * intervalSecs) {
    throw new Error(
      `TWAP_WINDOW_SECS (${twapWindowSecs}) must be at least twice AGENT_INTERVAL_SECS (${intervalSecs})`,
    );
  }
  const minLiquidityUsd = boundedInt(env, "MIN_LIQUIDITY_USD", MIN_LIQUIDITY_USD, 1, MAX_MIN_LIQUIDITY_USD);
  return { marketData: source, twapWindowSecs, minLiquidityUsd, refExchangeId };
}
