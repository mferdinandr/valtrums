import { compareDecimal, formatDecimal, parseDecimal } from "./decimal.js";
import type { AuditRecord, Reason } from "./decision.js";
import { CRITICAL_FLAGS, PRIVILEGE_FLAGS, TAX_FIELDS, type Tri } from "./goplus.js";
import { isKnownReasonCode } from "./reason-summary.js";
import { VALUATION_SOURCE } from "./liquidity.js";
import { ownershipRenounced, type Renounced } from "./policy.js";

/**
 * Human-readable audit report, keyed by `evidenceHash`, so users can plan strategy.
 * Pure data and text: no UI wiring and no I/O here.
 */

export interface AuditReport {
  /** Key of this report. */
  evidenceHash: string;
  result: AuditRecord["result"];
  auditKind: AuditRecord["auditKind"];
  /** Always stated: what the evidence is about. */
  attestation: string;
  policy: { version: string; hash: string; taxMaxPercent: string | null; adminRule: string | null };
  asset: { chainId: string; token: string; representation: string; custodyDomain: string; mappingVersion: string };
  reference: { chainId: string; token: string; registryEntryHash: string } | null;
  times: { queriedAt: string; decidedAt: string; expiresAt: string | null; ttlSeconds: number | null };
  critical: { field: string; state: Tri; reason: string }[];
  taxes: {
    field: string;
    status: "known" | "unknown" | "malformed";
    percent: string | null;
    withinLimit: boolean | null;
    note: string;
  }[];
  adminCapabilities: { field: string; state: Tri; active: boolean | null; admissible: boolean | null }[];
  ownership: {
    owner: string;
    hiddenOwner: Tri;
    canTakeBackOwnership: Tri;
    renouncedAndUnrecoverable: Renounced;
  };
  inspection: { isOpenSource: Tri; isProxy: Tri };
  liquidity: {
    /** Chain and token whose pools were measured. */
    measuredOn: { chainId: string; token: string };
    state: "pass" | "fail" | "pending";
    totalUsd: string | null;
    headlineUsd: string | null;
    requiredAboveUsd: string;
    pools: string[];
    /** Always `headline_quote_balance`. */
    valuationSource: string;
    /** Plain-words limitation of that valuation. */
    valuationNote: string;
  };
  reasons: Reason[];
}

/** Exact fraction to percent text: "0.05" becomes "5". */
export function fractionToPercent(fraction: string): string | null {
  const d = parseDecimal(fraction);
  if (!d) return null;
  const shifted =
    d.scale >= 2 ? { units: d.units, scale: d.scale - 2 } : { units: d.units * 10n ** BigInt(2 - d.scale), scale: 0 };
  return formatDecimal(shifted);
}

export function buildAuditReport(record: AuditRecord): AuditReport {
  const g = record.goplus;
  const policy = record.policy;
  const cap = policy.tax.status === "resolved" ? parseDecimal(policy.tax.maxFraction) : null;
  const renounced = ownershipRenounced(g.context);
  const owner =
    g.context.owner.kind === "none"
      ? "none (empty owner address)"
      : g.context.owner.kind === "address"
        ? g.context.owner.address
        : "unknown";
  const reference = record.asset.reference;
  return {
    evidenceHash: record.evidenceHash,
    result: record.result,
    auditKind: record.auditKind,
    attestation: reference
      ? `Reference-token audit: both the GoPlus risk check and the liquidity check describe the chain ` +
        `${reference.chainId} (mainnet) token ${reference.token}. The chain ${record.asset.chainId} test token ` +
        `${record.asset.token} was not itself audited, and this result says nothing about its contract behaviour.`
      : `Direct audit of chain ${record.asset.chainId} token ${record.asset.token}.`,
    policy: {
      version: record.policyVersion,
      hash: record.policyHash,
      taxMaxPercent: policy.tax.status === "resolved" ? fractionToPercent(policy.tax.maxFraction) : null,
      adminRule: policy.admin.status === "resolved" ? policy.admin.rule : null,
    },
    asset: {
      chainId: record.asset.chainId,
      token: record.asset.token,
      representation: record.asset.representation,
      custodyDomain: record.asset.custodyDomain,
      mappingVersion: record.asset.mappingVersion,
    },
    reference: reference
      ? { chainId: reference.chainId, token: reference.token, registryEntryHash: reference.registryEntryHash }
      : null,
    times: {
      queriedAt: record.queriedAt,
      decidedAt: record.decidedAt,
      expiresAt: record.expiresAt,
      ttlSeconds: policy.freshness.status === "resolved" ? policy.freshness.ttlSeconds : null,
    },
    critical: CRITICAL_FLAGS.map((f) => ({ field: f, state: g.critical[f].state, reason: g.critical[f].reason })),
    taxes: TAX_FIELDS.map((f) => {
      const t = g.tax[f];
      if (t.kind !== "known") {
        return { field: f, status: t.kind, percent: null, withinLimit: null, note: t.reason };
      }
      const v = parseDecimal(t.fraction);
      const within = cap && v ? compareDecimal(v, cap) <= 0 : null;
      return {
        field: f,
        status: "known" as const,
        percent: fractionToPercent(t.fraction),
        withinLimit: t.entirelyTaxed ? false : within,
        note: t.entirelyTaxed ? "entirely taxed: unusable path" : "exact decimal fraction",
      };
    }),
    adminCapabilities: PRIVILEGE_FLAGS.map((f) => {
      const state = g.privileges[f].state;
      const active = state === "unknown" ? null : state === "true";
      return {
        field: f,
        state,
        active,
        admissible: active === null ? null : active ? (renounced === "yes" ? true : renounced === "no" ? false : null) : true,
      };
    }),
    ownership: {
      owner,
      hiddenOwner: g.context.hiddenOwner.state,
      canTakeBackOwnership: g.context.canTakeBackOwnership.state,
      renouncedAndUnrecoverable: renounced,
    },
    inspection: { isOpenSource: g.context.isOpenSource.state, isProxy: g.context.isProxy.state },
    liquidity: {
      measuredOn: { chainId: record.evidenceSubject.chainId, token: record.evidenceSubject.token },
      state: record.lp.state,
      totalUsd: record.lp.totalUsd,
      headlineUsd: record.lp.headlineUsd,
      requiredAboveUsd: "10000",
      pools: record.lp.countedPools,
      valuationSource: VALUATION_SOURCE,
      valuationNote:
        "This is an approximation, not executable depth: only the quote-side balance of each pool is counted " +
        "(never the audited token's side); v3 balances can include out-of-range liquidity and can be moved briefly. " +
        "WETH quotes are priced from one configured WETH/stablecoin pool at the same block.",
    },
    reasons: record.reasons,
  };
}

const yn = (v: boolean | null) => (v === null ? "unknown" : v ? "yes" : "no");

/** Plain-text rendering of a report for display or logs. */
export function formatAuditReport(r: AuditReport): string {
  const lines: string[] = [];
  lines.push(`Audit report ${r.evidenceHash}`);
  lines.push(`Result: ${r.result.toUpperCase()} (policy ${r.policy.version}, hash ${r.policy.hash})`);
  lines.push(r.attestation);
  lines.push(
    `Asset: chain ${r.asset.chainId} token ${r.asset.token} representation ${r.asset.representation} ` +
      `custody ${r.asset.custodyDomain} mapping ${r.asset.mappingVersion}`,
  );
  if (r.reference) {
    lines.push(
      `Reference mapping: chain ${r.reference.chainId} token ${r.reference.token} (registry entry ${r.reference.registryEntryHash})`,
    );
  }
  lines.push(
    `Queried ${r.times.queriedAt || "n/a"}; decided ${r.times.decidedAt}; ` +
      `expires ${r.times.expiresAt ?? "n/a"}${r.times.ttlSeconds ? ` (TTL ${r.times.ttlSeconds}s)` : ""}`,
  );
  lines.push("Critical checks:");
  for (const c of r.critical) lines.push(`  ${c.field}: ${c.state}`);
  lines.push(`Taxes (limit ${r.policy.taxMaxPercent ?? "unresolved"}%):`);
  for (const t of r.taxes) {
    lines.push(
      `  ${t.field}: ${t.percent !== null ? `${t.percent}%` : t.status} within limit: ${yn(t.withinLimit)}`,
    );
  }
  lines.push(`Admin capabilities (ownership renounced and unrecoverable: ${r.ownership.renouncedAndUnrecoverable}):`);
  for (const a of r.adminCapabilities) {
    lines.push(`  ${a.field}: ${a.state} active: ${yn(a.active)} admissible: ${yn(a.admissible)}`);
  }
  lines.push(
    `Ownership: owner ${r.ownership.owner}, hidden owner ${r.ownership.hiddenOwner}, ` +
      `can take back ownership ${r.ownership.canTakeBackOwnership}`,
  );
  lines.push(`Inspection: open source ${r.inspection.isOpenSource}, proxy ${r.inspection.isProxy}`);
  lines.push(
    `Liquidity (measured on chain ${r.liquidity.measuredOn.chainId} token ${r.liquidity.measuredOn.token}): ${r.liquidity.state} total ${r.liquidity.totalUsd ?? "n/a"} USD ` +
      `(required strictly above ${r.liquidity.requiredAboveUsd}); pools ${r.liquidity.pools.join(", ") || "none"}`,
  );
  lines.push(`Valuation source: ${r.liquidity.valuationSource}. ${r.liquidity.valuationNote}`);
  lines.push("Reasons:");
  if (r.reasons.length === 0) lines.push("  none");
  for (const x of r.reasons) lines.push(`  [${x.code}]${x.field ? ` ${x.field}:` : ""} ${x.message}${isKnownReasonCode(x.code) ? "" : " (unknown reason code)"}`);
  return lines.join("\n");
}

/** Reports indexed by evidence hash. */
export class AuditReportStore {
  private readonly byHash = new Map<string, AuditReport>();
  put(record: AuditRecord): AuditReport {
    const report = buildAuditReport(record);
    this.byHash.set(report.evidenceHash, report);
    return report;
  }
  get(evidenceHash: string): AuditReport | undefined {
    return this.byHash.get(evidenceHash);
  }
}
