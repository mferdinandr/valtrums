import { inspectGoPlusEvidence, type AuditAsset, type GoPlusEvidence, type Finding } from "./goplus-audit.js";
import { inspectLiquidity, type LiquidityEvidence } from "./arena-liquidity.js";

/** Preliminary evidence inspection only. The live policy, freshness, source
 * authentication and lifecycle approval interface are not yet specified. */
export function inspectArenaAudit(asset: AuditAsset, goplus: GoPlusEvidence, liquidity?: LiquidityEvidence): {
  decision: "Reject" | "Pending";
  evidenceHash: string;
  findings: Finding[];
} {
  const risk = inspectGoPlusEvidence(asset, goplus);
  const depth = inspectLiquidity(asset, liquidity);
  return {
    decision: risk.decision === "Reject" || depth.decision === "Reject" ? "Reject" : "Pending",
    evidenceHash: risk.evidenceHash,
    findings: [
      ...risk.findings,
      { field: "independent_liquidity", value: depth.decision, reason: depth.reason },
      { field: "approval_policy", value: null, reason: "Tax, admin, freshness, source authentication and lifecycle approval remain unresolved" },
    ],
  };
}
