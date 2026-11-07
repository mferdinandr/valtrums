import { compareDecimal, parseDecimal } from "./decimal.js";
import type { FlagState, NormalizedGoPlus, PrivilegeFlag, TaxField, TaxState } from "./goplus.js";
import { PRIVILEGE_FLAGS, TAX_FIELDS } from "./goplus.js";

/**
 * Versioned audit policy as plain data. Every admissibility literal lives here so that
 * `policyHash` commits to exactly the decisions that were applied. The recovery behaviour
 * after a live token-policy change is still OPEN and intentionally not represented.
 */

export const AUDIT_POLICY_VERSION = "audit-policy-v1";
/** Owner decision: each tax is admissible up to and including 5% (exact decimal fraction). */
export const MAX_TAX_FRACTION = "0.05";
/** Owner decision: default evidence TTL, configurable. */
export const DEFAULT_EVIDENCE_TTL_SECONDS = 600;

export type TaxPolicy =
  | { status: "unresolved" }
  | { status: "resolved"; id: string; maxFraction: string };

export type AdminPolicy =
  | { status: "unresolved" }
  | {
      status: "resolved";
      id: string;
      /** Capabilities admissible only when ownership is renounced and unrecoverable. */
      capabilities: readonly PrivilegeFlag[];
      rule: "ownership_renounced_and_unrecoverable";
    };

/** Evidence TTL and refresh cadence; unresolved means nothing can be fresh. */
export type FreshnessPolicy =
  | { status: "unresolved" }
  | { status: "resolved"; id: string; ttlSeconds: number };

export interface AuditPolicy {
  version: string;
  tax: TaxPolicy;
  admin: AdminPolicy;
  freshness: FreshnessPolicy;
  /** How GoPlus evidence may attach to a token that GoPlus does not cover. */
  reference: { mode: "protocol_registry"; id: string };
}

export interface PolicyReason {
  code: string;
  field?: string;
  message: string;
}
export interface PolicyOutcome {
  verdict: "accept" | "reject" | "pending";
  reasons: PolicyReason[];
}

export function buildAuditPolicy(opts: { ttlSeconds?: number } = {}): AuditPolicy {
  const ttl = opts.ttlSeconds ?? DEFAULT_EVIDENCE_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error("evidence TTL must be a positive integer of seconds");
  return {
    version: AUDIT_POLICY_VERSION,
    tax: { status: "resolved", id: "tax-cap-v1", maxFraction: MAX_TAX_FRACTION },
    admin: {
      status: "resolved",
      id: "admin-renounced-v1",
      capabilities: PRIVILEGE_FLAGS,
      rule: "ownership_renounced_and_unrecoverable",
    },
    freshness: { status: "resolved", id: "freshness-v1", ttlSeconds: ttl },
    reference: { mode: "protocol_registry", id: "reference-registry-v1" },
  };
}

/** Policy with every OPEN decision unresolved: holds everything Pending. */
export const UNRESOLVED_POLICY: AuditPolicy = {
  version: "audit-policy-v0-unresolved",
  tax: { status: "unresolved" },
  admin: { status: "unresolved" },
  freshness: { status: "unresolved" },
  reference: { mode: "protocol_registry", id: "reference-registry-v1" },
};

export function evaluateTaxPolicy(policy: TaxPolicy, tax: Record<TaxField, TaxState>): PolicyOutcome {
  if (policy.status === "unresolved") {
    return {
      verdict: "pending",
      reasons: [{ code: "tax_policy_unresolved", message: "tax threshold policy is OPEN" }],
    };
  }
  const cap = parseDecimal(policy.maxFraction);
  if (!cap) throw new Error("invalid tax cap in policy");
  const reasons: PolicyReason[] = [];
  let verdict: PolicyOutcome["verdict"] = "accept";
  for (const field of TAX_FIELDS) {
    const t = tax[field];
    if (t.kind !== "known") {
      verdict = verdict === "reject" ? verdict : "pending"; // unknown findings are reported by normalization
      continue;
    }
    const value = parseDecimal(t.fraction);
    if (value && compareDecimal(value, cap) > 0 && !t.entirelyTaxed) {
      verdict = "reject";
      reasons.push({
        code: "tax_above_limit",
        field,
        message: `${field} ${t.fraction} exceeds the admissible maximum ${policy.maxFraction}`,
      });
    }
  }
  return { verdict, reasons };
}

const ZERO_ADDRESS = /^0x0{40}$/i;

export type Renounced = "yes" | "no" | "unknown";

/** Renounced and unrecoverable: owner empty or zero, hidden_owner false, can_take_back_ownership false. */
export function ownershipRenounced(context: NormalizedGoPlus["context"]): Renounced {
  const ownerRenounced =
    context.owner.kind === "none" ||
    (context.owner.kind === "address" && ZERO_ADDRESS.test(context.owner.address));
  const ownerActive = context.owner.kind === "address" && !ZERO_ADDRESS.test(context.owner.address);
  if (ownerActive || context.hiddenOwner.state === "true" || context.canTakeBackOwnership.state === "true") {
    return "no";
  }
  if (
    ownerRenounced &&
    context.hiddenOwner.state === "false" &&
    context.canTakeBackOwnership.state === "false"
  ) {
    return "yes";
  }
  return "unknown";
}

export function evaluateAdminPolicy(
  policy: AdminPolicy,
  privileges: Record<PrivilegeFlag, FlagState>,
  context: NormalizedGoPlus["context"],
): PolicyOutcome {
  if (policy.status === "unresolved") {
    return {
      verdict: "pending",
      reasons: [{ code: "admin_policy_unresolved", message: "privileged-admin policy is OPEN" }],
    };
  }
  const active = policy.capabilities.filter((c) => privileges[c].state === "true");
  const anyUnknown = policy.capabilities.some((c) => privileges[c].state === "unknown");
  const renounced = ownershipRenounced(context);
  const reasons: PolicyReason[] = [];
  if (active.length > 0 && renounced === "no") {
    for (const field of active) {
      reasons.push({
        code: "admin_privilege_not_renounced",
        field,
        message: `${field} is active and ownership is not renounced and unrecoverable`,
      });
    }
    return { verdict: "reject", reasons };
  }
  if (active.length > 0 && renounced === "unknown") {
    reasons.push({
      code: "ownership_unknown",
      message: "an admin capability is active and ownership status cannot be established",
    });
    return { verdict: "pending", reasons };
  }
  return { verdict: anyUnknown ? "pending" : "accept", reasons };
}
