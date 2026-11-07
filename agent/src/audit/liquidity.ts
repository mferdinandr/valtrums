import { ZERO, addDecimal, compareDecimal, formatDecimal, parseDecimal, type Decimal } from "./decimal.js";

/** Independent LP gate: total eligible liquidity must be strictly greater than USD 10000. */
export const MIN_LIQUIDITY_USD: Decimal = { units: 10000n, scale: 0 };

/**
 * Valuation source label carried in evidence, hashes and the user report. It is a headline
 * approximation of the QUOTE-side balance only (never the audited token's side); it is not
 * executable depth, and v3 balances can include out-of-range liquidity and be moved briefly.
 */
export const VALUATION_SOURCE = "headline_quote_balance";

export type UnpricedCode =
  | "quote_asset_unpriced"
  | "price_pool_floor_unset"
  | "price_pool_floor_not_met"
  | "price_pool_invalid";

export interface PoolEvidence {
  chainId: string;
  poolId: string;
  /** Source-chain token the pool trades; must equal the audited token. */
  token: string;
  quoteAsset: string;
  kind: "constant_product" | "concentrated";
  /** USD value of the quote-side balance (decimal text); the value that is counted. */
  headlineUsd: string | null;
  /** Set when the quote asset could not be priced; the pool then contributes nothing and holds Pending. */
  unpriced?: UnpricedCode;
  /** For a priced WETH quote: the WETH/stablecoin v3 pool, its slot0 price and stable-side balance, read in the same block. */
  quotePricing?: {
    pricePool: string;
    sqrtPriceX96: string;
    wethIsToken0: boolean;
    stableBalanceUsd: string;
    block: string;
  };
  valuationSource: string | null;
  observedAt: string | null; // ISO time
  observedBlock: string | null;
}

export interface LpEvidence {
  chainId: string;
  token: string;
  pools: PoolEvidence[];
}

export interface LpReason {
  code:
    | "no_evidence"
    | "no_eligible_pool"
    | "mismatched_asset"
    | "duplicate_pool"
    | "conflicting_duplicate"
    | "unreliable_valuation"
    | UnpricedCode
    | "at_or_below_threshold";
  poolId?: string;
  message: string;
}

export interface LpResult {
  state: "pass" | "fail" | "pending";
  /** Sum of counted pool values; null when nothing could be counted. */
  totalUsd: string | null;
  headlineUsd: string | null;
  countedPools: string[];
  /** Oldest observation time among counted pools (ISO), used for freshness. */
  oldestObservedAt: string | null;
  reasons: LpReason[];
}

const key = (chainId: string, poolId: string) => `${chainId}:${poolId.toLowerCase()}`;

/** Evaluates LP evidence for one asset. `fail` means measured value <= 10000; anything unreliable is `pending`. */
export function evaluateLiquidity(
  asset: { chainId: string; token: string },
  evidence: LpEvidence | null | undefined,
): LpResult {
  const reasons: LpReason[] = [];
  const pending = (): LpResult => ({
    state: "pending",
    totalUsd: null,
    headlineUsd: null,
    countedPools: [],
    oldestObservedAt: null,
    reasons,
  });
  if (!evidence || evidence.pools.length === 0) {
    reasons.push({ code: "no_evidence", message: "no independent LP evidence" });
    return pending();
  }
  if (evidence.chainId !== asset.chainId || evidence.token.toLowerCase() !== asset.token.toLowerCase()) {
    reasons.push({ code: "mismatched_asset", message: "LP evidence is for another chain or token" });
    return pending();
  }

  const seen = new Map<string, PoolEvidence>();
  let unreliable = false;
  let unpriced = false;
  let counted = ZERO;
  const countedPools: string[] = [];
  let oldest: string | null = null;

  for (const pool of evidence.pools) {
    if (pool.chainId !== asset.chainId || pool.token.toLowerCase() !== asset.token.toLowerCase()) {
      reasons.push({ code: "mismatched_asset", poolId: pool.poolId, message: "pool belongs to another asset; ignored" });
      continue;
    }
    const k = key(pool.chainId, pool.poolId);
    const prior = seen.get(k);
    if (prior) {
      const same = (p: PoolEvidence) => JSON.stringify({ ...p, poolId: p.poolId.toLowerCase() });
      if (same(prior) !== same(pool)) {
        reasons.push({ code: "conflicting_duplicate", poolId: pool.poolId, message: "same pool reported with different values" });
        unreliable = true;
      } else {
        reasons.push({ code: "duplicate_pool", poolId: pool.poolId, message: "duplicate pool counted once" });
      }
      continue;
    }
    seen.set(k, pool);

    if (pool.unpriced) {
      reasons.push({
        code: pool.unpriced,
        poolId: pool.poolId,
        message: `quote asset ${pool.quoteAsset} could not be priced (${pool.unpriced})`,
      });
      // An unpriced pool is not counted. Not counting it can only understate liquidity, so a total
      // above the threshold still passes, while a total at or below it holds Pending (not Fail).
      unpriced = true;
      continue;
    }
    const value = parseDecimal(pool.headlineUsd);
    const observed = pool.observedAt !== null && !Number.isNaN(Date.parse(pool.observedAt));
    const located = observed || (pool.observedBlock !== null && pool.observedBlock !== "");
    if (!value || pool.valuationSource !== VALUATION_SOURCE || !located) {
      reasons.push({
        code: "unreliable_valuation",
        poolId: pool.poolId,
        message: `missing value, valuation source ${VALUATION_SOURCE} or observation time/block`,
      });
      unreliable = true;
      continue;
    }
    counted = addDecimal(counted, value);
    countedPools.push(pool.poolId);
    if (observed && (oldest === null || Date.parse(pool.observedAt!) < Date.parse(oldest))) {
      oldest = pool.observedAt;
    }
  }

  if (unreliable || countedPools.length === 0) {
    if (countedPools.length === 0 && !unreliable && !unpriced) {
      reasons.push({ code: "no_eligible_pool", message: "no eligible pool for this asset" });
    }
    return pending();
  }
  const totalUsd = formatDecimal(counted);
  // Headline and counted value are now the same quantity (quote-side balance).
  const base = { totalUsd, headlineUsd: totalUsd, countedPools, oldestObservedAt: oldest };
  if (compareDecimal(counted, MIN_LIQUIDITY_USD) > 0) return { ...base, state: "pass", reasons };
  if (unpriced) return { ...base, state: "pending", reasons };
  reasons.push({
    code: "at_or_below_threshold",
    message: `liquidity ${totalUsd} USD is not strictly greater than 10000`,
  });
  return { ...base, state: "fail", reasons };
}
