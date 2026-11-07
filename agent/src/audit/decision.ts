import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  normalizeGoPlus,
  type NormalizedGoPlus,
  type PrivilegeFlag,
  type RawGoPlusResponse,
  type FlagState,
  type TaxField,
  type TaxState,
} from "./goplus.js";
import { evaluateLiquidity, type LpEvidence, type LpResult } from "./liquidity.js";

export type AuditResult = "pass" | "reject" | "pending";

/** Source asset plus its NEAR representation; evidence and approvals bind all of it. */
export interface AuditAsset {
  chainId: string;
  token: string;
  representation: string;
  custodyDomain: string;
  mappingVersion: string;
}

export type PolicyVerdict = "accept" | "reject" | "pending";

/**
 * Tax thresholds and privileged-admin admissibility are OPEN product decisions.
 * The default is `unresolved`, which holds every token Pending. A resolved policy
 * must be supplied by an explicit owner decision; this module invents no values.
 */
export type TaxPolicy =
  | { status: "unresolved" }
  | { status: "resolved"; id: string; evaluate: (tax: Record<TaxField, TaxState>) => PolicyVerdict };
export type AdminPolicy =
  | { status: "unresolved" }
  | {
      status: "resolved";
      id: string;
      evaluate: (privileges: Record<PrivilegeFlag, FlagState>, n: NormalizedGoPlus) => PolicyVerdict;
    };
/** Evidence TTL and refresh cadence are OPEN; unresolved means nothing can be fresh. */
export type FreshnessPolicy = { status: "unresolved" } | { status: "resolved"; id: string; ttlMs: number };

export interface AuditPolicy {
  version: string;
  tax: TaxPolicy;
  admin: AdminPolicy;
  freshness: FreshnessPolicy;
}

export const UNRESOLVED_POLICY: AuditPolicy = {
  version: "audit-policy-v0-unresolved",
  tax: { status: "unresolved" },
  admin: { status: "unresolved" },
  freshness: { status: "unresolved" },
};

export interface Reason {
  code: string;
  field?: string;
  message: string;
}

export interface AuditRecord {
  asset: AuditAsset;
  result: AuditResult;
  reasons: Reason[];
  policyVersion: string;
  policyHash: string;
  evidenceHash: string;
  rawResponseHash: string;
  rawResponse: string;
  providerVersion: string;
  queriedAt: string;
  decidedAt: string;
  /** Approval stops being valid at this time; null when no freshness policy is resolved. */
  expiresAt: string | null;
  goplus: NormalizedGoPlus;
  lp: LpResult;
}

const hex = (text: string) => bytesToHex(sha256(utf8ToBytes(text)));

/** Commits to the policy version and which OPEN decisions are resolved, never to function bodies. */
export function policyHash(policy: AuditPolicy): string {
  return hex(
    JSON.stringify({
      version: policy.version,
      tax: policy.tax.status === "resolved" ? policy.tax.id : null,
      admin: policy.admin.status === "resolved" ? policy.admin.id : null,
      freshness:
        policy.freshness.status === "resolved"
          ? { id: policy.freshness.id, ttlMs: policy.freshness.ttlMs }
          : null,
      lpMinUsdExclusive: "10000",
    }),
  );
}

export interface AuditInput {
  asset: AuditAsset;
  goplus: RawGoPlusResponse;
  lp: LpEvidence | null;
  policy: AuditPolicy;
  now: Date;
}

export function evaluateCommunity(input: AuditInput): AuditRecord {
  const { asset, policy, now } = input;
  const reasons: Reason[] = [];
  const g = normalizeGoPlus(input.goplus);
  const lp = evaluateLiquidity(asset, input.lp);

  const identityOk =
    input.goplus.query.chainId === asset.chainId &&
    input.goplus.query.token.toLowerCase() === asset.token.toLowerCase();
  let rejected = false;
  let pending = false;
  const hold = (r: Reason) => {
    pending = true;
    reasons.push(r);
  };

  if (!identityOk) {
    hold({ code: "wrong_source", message: "GoPlus query was for another chain or token" });
  } else if (g.source.status !== "ok") {
    hold({ code: `source_${g.source.status}`, message: g.source.reason });
  } else {
    for (const f of g.findings) {
      if (f.severity === "critical") {
        rejected = true;
        reasons.push({ code: "critical", field: f.field, message: f.reason });
      } else if (f.severity === "unknown") {
        // Unknown required fields hold Pending, but are always retained, even next to a reject.
        hold({ code: "unknown_field", field: f.field, message: f.reason });
      }
    }
    if (!rejected) {
      if (policy.tax.status === "unresolved") {
        hold({ code: "tax_policy_unresolved", message: "tax threshold policy is OPEN" });
      } else {
        const v = policy.tax.evaluate(g.tax);
        if (v === "reject") {
          rejected = true;
          reasons.push({ code: "tax_policy_reject", message: "tax rejected by resolved policy" });
        } else if (v === "pending") hold({ code: "tax_policy_pending", message: "tax policy returned pending" });
      }
      if (policy.admin.status === "unresolved") {
        hold({ code: "admin_policy_unresolved", message: "privileged-admin policy is OPEN" });
      } else {
        const v = policy.admin.evaluate(g.privileges, g);
        if (v === "reject") {
          rejected = true;
          reasons.push({ code: "admin_policy_reject", message: "privilege rejected by resolved policy" });
        } else if (v === "pending") hold({ code: "admin_policy_pending", message: "admin policy returned pending" });
      }
    }
  }

  // Independent LP gate. Below/equal threshold withholds approval; unknown holds Pending.
  for (const r of lp.reasons) {
    if (lp.state !== "pass" || r.code === "duplicate_pool" || r.code === "mismatched_asset") {
      reasons.push({ code: `lp_${r.code}`, field: r.poolId, message: r.message });
    }
  }
  if (lp.state !== "pass") pending = true;

  // Freshness: GoPlus and LP observation both must be within the TTL.
  let expiresAt: string | null = null;
  if (policy.freshness.status === "unresolved") {
    hold({ code: "freshness_policy_unresolved", message: "evidence TTL policy is OPEN" });
  } else {
    const ttl = policy.freshness.ttlMs;
    const times = [input.goplus.queriedAt, lp.oldestObservedAt].map((t) => (t ? Date.parse(t) : NaN));
    if (times.some((t) => Number.isNaN(t))) {
      hold({ code: "evidence_time_missing", message: "evidence timestamp missing or invalid" });
    } else if (times.some((t) => t > now.getTime())) {
      hold({ code: "evidence_from_future", message: "evidence timestamp is after decision time" });
    } else {
      const oldest = Math.min(...(times as number[]));
      expiresAt = new Date(oldest + ttl).toISOString();
      if (now.getTime() >= oldest + ttl) hold({ code: "stale_evidence", message: "evidence is older than the freshness TTL" });
    }
  }

  const result: AuditResult = rejected ? "reject" : pending ? "pending" : "pass";
  const rawResponseHash = hex(input.goplus.rawText);
  const pHash = policyHash(policy);
  const evidenceHash = hex(
    JSON.stringify({
      asset,
      rawResponseHash,
      providerVersion: input.goplus.providerVersion,
      queriedAt: input.goplus.queriedAt,
      lp: input.lp,
      policyHash: pHash,
    }),
  );
  return {
    asset,
    result,
    reasons,
    policyVersion: policy.version,
    policyHash: pHash,
    evidenceHash,
    rawResponseHash,
    rawResponse: input.goplus.rawText,
    providerVersion: input.goplus.providerVersion,
    queriedAt: input.goplus.queriedAt,
    decidedAt: now.toISOString(),
    expiresAt: result === "pass" ? expiresAt : null,
    goplus: g,
    lp,
  };
}
