import type { AuditAsset } from "./goplus-audit.js";

/** Evidence is supplied by a separate adapter; fixtures never imply live coverage. */
export interface LiquidityEvidence {
  asset: AuditAsset;
  source: string;
  poolIds: string[];
  quoteAsset: string;
  valuationSource: string;
  observedAt: string;
  blockReference: string;
  usdValue: string;
  kind: "fixture" | "live";
}

/** Compare exact decimal USD values without floating point or rounding. */
export function inspectLiquidity(expected: AuditAsset, evidence?: LiquidityEvidence): {
  decision: "Pass" | "Reject" | "Pending"; reason: string;
} {
  const pending = (reason: string) => ({ decision: "Pending" as const, reason });
  if (!evidence) return pending("Independent liquidity evidence missing");
  if ((Object.keys(expected) as (keyof AuditAsset)[]).some((key) => !expected[key] || expected[key] !== evidence.asset[key])) {
    return pending("Liquidity asset mapping does not match");
  }
  if (!evidence.source || !evidence.quoteAsset || !evidence.valuationSource || !evidence.observedAt || !evidence.blockReference ||
      evidence.poolIds.length === 0 || evidence.poolIds.some((id) => !id) || new Set(evidence.poolIds).size !== evidence.poolIds.length) {
    return pending("Liquidity provenance is incomplete or pools are duplicated");
  }
  if (evidence.usdValue.length > 128 || !/^\d+(?:\.\d+)?$/.test(evidence.usdValue)) return pending("Liquidity valuation is malformed");
  const [whole = "", fraction = ""] = evidence.usdValue.split(".");
  const amount = BigInt(whole + fraction);
  const threshold = 10_000n * 10n ** BigInt(fraction.length);
  return amount > threshold
    ? { decision: "Pass", reason: `${evidence.kind} liquidity exceeds USD 10000; freshness and source verification remain separate gates` }
    : { decision: "Reject", reason: "Liquidity is not strictly above USD 10000" };
}
