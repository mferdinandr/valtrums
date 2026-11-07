import { ZERO, addDecimal, compareDecimal, formatDecimal, parseDecimal, type Decimal } from "./decimal.js";

/** Independent LP gate: total eligible liquidity must be strictly greater than USD 10000. */
export const MIN_LIQUIDITY_USD: Decimal = { units: 10000n, scale: 0 };

export interface PoolEvidence {
  chainId: string;
  poolId: string;
  /** Source-chain token the pool trades; must equal the audited token. */
  token: string;
  quoteAsset: string;
  kind: "constant_product" | "concentrated";
  /** Headline USD value of the pool (decimal text). */
  headlineUsd: string | null;
  /** Active/executable depth in USD; required to count a concentrated pool. */
  executableDepthUsd?: string | null;
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
  let counted = ZERO;
  let headline = ZERO;
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

    const headlineValue = parseDecimal(pool.headlineUsd);
    const counted_ =
      pool.kind === "concentrated" ? parseDecimal(pool.executableDepthUsd) : headlineValue;
    const observed = pool.observedAt !== null && !Number.isNaN(Date.parse(pool.observedAt));
    const located = observed || (pool.observedBlock !== null && pool.observedBlock !== "");
    if (!counted_ || !headlineValue || !pool.valuationSource || !located) {
      reasons.push({
        code: "unreliable_valuation",
        poolId: pool.poolId,
        message:
          pool.kind === "concentrated" && !parseDecimal(pool.executableDepthUsd)
            ? "concentrated pool lacks executable depth"
            : "missing value, valuation source or observation time/block",
      });
      unreliable = true;
      continue;
    }
    counted = addDecimal(counted, counted_);
    headline = addDecimal(headline, headlineValue);
    countedPools.push(pool.poolId);
    if (observed && (oldest === null || Date.parse(pool.observedAt!) < Date.parse(oldest))) {
      oldest = pool.observedAt;
    }
  }

  if (unreliable || countedPools.length === 0) {
    if (countedPools.length === 0 && !unreliable) {
      reasons.push({ code: "no_eligible_pool", message: "no eligible pool for this asset" });
    }
    return pending();
  }
  const totalUsd = formatDecimal(counted);
  const base = { totalUsd, headlineUsd: formatDecimal(headline), countedPools, oldestObservedAt: oldest };
  if (compareDecimal(counted, MIN_LIQUIDITY_USD) > 0) return { ...base, state: "pass", reasons };
  reasons.push({
    code: "at_or_below_threshold",
    message: `liquidity ${totalUsd} USD is not strictly greater than 10000`,
  });
  return { ...base, state: "fail", reasons };
}
