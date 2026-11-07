import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { normalizeGoPlus, unusableGoPlus, type NormalizedGoPlus, type RawGoPlusResponse } from "./goplus.js";
import { evaluateLiquidity, type LpEvidence, type LpResult } from "./liquidity.js";
import { evaluateAdminPolicy, evaluateTaxPolicy, type AuditPolicy, type PolicyOutcome } from "./policy.js";
import type { ReferenceBinding } from "./reference.js";

export { UNRESOLVED_POLICY, type AuditPolicy } from "./policy.js";

export type AuditResult = "pass" | "reject" | "pending";

/** Source asset plus its NEAR representation; evidence and approvals bind all of it. */
export interface AuditAsset {
  chainId: string;
  token: string;
  representation: string;
  custodyDomain: string;
  mappingVersion: string;
  /** Present when GoPlus is queried for a reference token instead of the asset itself. */
  reference?: ReferenceBinding;
}

export interface Reason {
  code: string;
  field?: string;
  message: string;
}

export type AuditKind = "direct" | "reference_token";

export interface AuditRecord {
  asset: AuditAsset;
  /** `reference_token`: GoPlus evidence attests the reference token, not the asset contract. */
  auditKind: AuditKind;
  /**
   * What both the GoPlus and the LP evidence describe. For a reference-token audit this is the
   * mainnet reference token and `assetItselfAudited` is false: the testnet mock was not audited.
   */
  evidenceSubject: { chainId: string; token: string; covers: ["goplus", "lp"]; assetItselfAudited: boolean };
  result: AuditResult;
  reasons: Reason[];
  policy: AuditPolicy;
  policyVersion: string;
  policyHash: string;
  evidenceHash: string;
  rawResponseHash: string;
  rawResponse: string;
  providerVersion: string;
  queriedAt: string;
  decidedAt: string;
  /** Approval stops being valid at this time; null unless the result is a pass with a resolved TTL. */
  expiresAt: string | null;
  goplus: NormalizedGoPlus;
  lp: LpResult;
}

const hex = (text: string) => bytesToHex(sha256(utf8ToBytes(text)));

/** Commits to every resolved decision and its parameters (cap, capability list, rule, TTL, reference mode). */
export function policyHash(policy: AuditPolicy): string {
  return hex(JSON.stringify({ policy, lpMinUsdExclusive: "10000" }));
}

export interface AuditInput {
  asset: AuditAsset;
  /** Null when no provider query was made (for example an unresolved reference mapping). */
  goplus: RawGoPlusResponse | null;
  lp: LpEvidence | null;
  policy: AuditPolicy;
  now: Date;
  /** A reference-mapping problem that holds the audit Pending. */
  referenceHold?: Reason;
}

/** The chain/token GoPlus must be queried for. */
export function goplusTarget(asset: AuditAsset): { chainId: string; token: string } {
  return asset.reference
    ? { chainId: asset.reference.chainId, token: asset.reference.token }
    : { chainId: asset.chainId, token: asset.token };
}

export function evaluateCommunity(input: AuditInput): AuditRecord {
  const { asset, policy, now } = input;
  const reasons: Reason[] = [];
  const auditKind: AuditKind = asset.reference ? "reference_token" : "direct";
  // LP depth is measured for the same subject GoPlus audits: the reference token when mapped.
  const lp = evaluateLiquidity(goplusTarget(asset), input.lp);
  let rejected = false;
  let pending = false;
  const hold = (r: Reason) => {
    pending = true;
    reasons.push(r);
  };
  const apply = (o: PolicyOutcome) => {
    reasons.push(...o.reasons);
    if (o.verdict === "reject") rejected = true;
    else if (o.verdict === "pending") pending = true;
  };

  let g: NormalizedGoPlus;
  const target = goplusTarget(asset);
  if (input.referenceHold) {
    g = unusableGoPlus(input.referenceHold.message);
    hold(input.referenceHold);
  } else if (!input.goplus) {
    g = unusableGoPlus("no provider response");
    hold({ code: "source_error", message: "no provider response" });
  } else if (
    input.goplus.query.chainId !== target.chainId ||
    input.goplus.query.token.toLowerCase() !== target.token.toLowerCase()
  ) {
    g = unusableGoPlus("GoPlus query does not match the audited chain/token");
    hold({ code: "wrong_source", message: "GoPlus query was for another chain or token" });
  } else {
    g = normalizeGoPlus(input.goplus);
    if (g.source.status !== "ok") {
      hold({ code: `source_${g.source.status}`, message: g.source.reason });
    } else {
      for (const f of g.findings) {
        if (f.severity === "critical") {
          rejected = true;
          reasons.push({ code: "critical", field: f.field, message: f.reason });
        } else if (f.severity === "unknown") {
          // Unknown required fields hold Pending, and stay listed even beside a reject.
          hold({ code: "unknown_field", field: f.field, message: f.reason });
        }
      }
      apply(evaluateTaxPolicy(policy.tax, g.tax));
      apply(evaluateAdminPolicy(policy.admin, g.privileges, g.context));
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
    const ttlMs = policy.freshness.ttlSeconds * 1000;
    const times = [input.goplus?.queriedAt, lp.oldestObservedAt].map((t) => (t ? Date.parse(t) : NaN));
    if (times.some((t) => Number.isNaN(t))) {
      hold({ code: "evidence_time_missing", message: "evidence timestamp missing or invalid" });
    } else if (times.some((t) => t > now.getTime())) {
      hold({ code: "evidence_from_future", message: "evidence timestamp is after decision time" });
    } else {
      const oldest = Math.min(...(times as number[]));
      expiresAt = new Date(oldest + ttlMs).toISOString();
      if (now.getTime() >= oldest + ttlMs) {
        hold({ code: "stale_evidence", message: "evidence is older than the freshness TTL" });
      }
    }
  }

  const result: AuditResult = rejected ? "reject" : pending ? "pending" : "pass";
  const rawText = input.goplus?.rawText ?? "";
  const rawResponseHash = hex(rawText);
  const pHash = policyHash(policy);
  const evidenceSubject = {
    chainId: target.chainId,
    token: target.token.toLowerCase(),
    covers: ["goplus", "lp"] as ["goplus", "lp"],
    assetItselfAudited: !asset.reference,
  };
  const evidenceHash = hex(
    JSON.stringify({
      auditKind,
      evidenceSubject,
      asset,
      rawResponseHash,
      providerVersion: input.goplus?.providerVersion ?? null,
      queriedAt: input.goplus?.queriedAt ?? null,
      lp: input.lp,
      policyHash: pHash,
    }),
  );
  return {
    asset,
    auditKind,
    evidenceSubject,
    result,
    reasons,
    policy,
    policyVersion: policy.version,
    policyHash: pHash,
    evidenceHash,
    rawResponseHash,
    rawResponse: rawText,
    providerVersion: input.goplus?.providerVersion ?? "",
    queriedAt: input.goplus?.queriedAt ?? "",
    decidedAt: now.toISOString(),
    expiresAt: result === "pass" ? expiresAt : null,
    goplus: g,
    lp,
  };
}
