import { createHash } from "node:crypto";

/** Normalized GoPlus findings. This adapter cannot grant lifecycle approval. */
export type Flag = boolean | null;
export type Finding = { field: string; value: unknown; reason: string };

export interface AuditAsset {
  chainId: string;
  token: string;
  representation: string;
  custodyDomain: string;
  mappingVersion: string;
}

export interface GoPlusEvidence {
  asset: AuditAsset;
  queriedChainId: string;
  queriedToken: string;
  provider: string;
  apiVersion: string;
  queriedAt: string;
  policyVersion: string;
  /** Exact response bytes, retained with their digest; no claim of provider authentication. */
  rawResponse: string;
}

/** Fetch only from the official endpoint; a successful response is still subject
 * to coverage, policy, independent liquidity and lifecycle authorization gates. */
export async function fetchGoPlusEvidence(
  asset: AuditAsset,
  policyVersion: string,
  fetcher: typeof fetch = fetch,
): Promise<GoPlusEvidence> {
  if (!/^\d+$/.test(asset.chainId) || !/^0x[0-9a-f]{40}$/i.test(asset.token) || !policyVersion.trim()) {
    throw new Error("Invalid GoPlus request identity or policy");
  }
  const url = new URL(`https://api.gopluslabs.io/api/v1/token_security/${asset.chainId}`);
  url.searchParams.set("contract_addresses", asset.token);
  const response = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GoPlus request failed (${response.status})`);
  return {
    asset, queriedChainId: asset.chainId, queriedToken: asset.token,
    provider: "GoPlus", apiVersion: "v1", queriedAt: new Date().toISOString(),
    policyVersion, rawResponse: await response.text(),
  };
}

/** Normalize a response only when its requested source and asset mapping match.
 * A digest ensures content identity, not provider authenticity or freshness. */
export function inspectGoPlusEvidence(expected: AuditAsset, evidence: GoPlusEvidence): {
  decision: "Reject" | "Pending";
  evidenceHash: string;
  findings: Finding[];
} {
  const evidenceHash = createHash("sha256").update(evidence.rawResponse, "utf8").digest("hex");
  const pending = (reason: string) => ({ decision: "Pending" as const, evidenceHash, findings: [{ field: "evidence", value: null, reason }] });
  if (Object.values(expected).some((value) => !value) ||
      (Object.keys(expected) as (keyof AuditAsset)[]).some((key) => expected[key] !== evidence.asset[key]) ||
      evidence.queriedChainId !== expected.chainId || evidence.queriedToken.toLowerCase() !== expected.token.toLowerCase()) {
    return pending("Evidence does not match the expected asset and source identity");
  }
  if (!evidence.provider || !evidence.apiVersion || !evidence.queriedAt || !evidence.policyVersion) {
    return pending("Evidence provenance is incomplete");
  }
  let response: unknown;
  try { response = JSON.parse(evidence.rawResponse); } catch { return pending("Malformed provider response"); }
  if (!response || typeof response !== "object" || Array.isArray(response)) return pending("Malformed provider response");
  const body = response as Record<string, unknown>;
  if (body.code !== 1 || !body.result || typeof body.result !== "object" || Array.isArray(body.result)) {
    return pending("Provider error or missing result");
  }
  const entries = Object.entries(body.result as Record<string, unknown>)
    .filter(([token]) => token.toLowerCase() === expected.token.toLowerCase());
  if (entries.length !== 1 || !entries[0]?.[1] || typeof entries[0][1] !== "object" || Array.isArray(entries[0][1])) {
    return pending("Provider result is missing or ambiguous for the expected token");
  }
  return { evidenceHash, ...normalizeGoPlus(entries[0][1] as Record<string, unknown>) };
}

const critical = ["is_honeypot", "cannot_sell_all", "cannot_buy"] as const;
const taxes = ["buy_tax", "sell_tax", "transfer_tax"] as const;
const privileges = [
  "slippage_modifiable", "personal_slippage_modifiable", "transfer_pausable",
  "owner_change_balance", "is_blacklisted", "is_whitelisted", "is_mintable",
  "is_open_source", "is_proxy", "hidden_owner", "can_take_back_ownership",
] as const;

function flag(value: unknown): Flag {
  return value === "1" ? true : value === "0" ? false : null;
}

/** Retain the exact decimal string; reject exponents, signs and values outside [0,1]. */
function fraction(value: unknown): string | null {
  if (typeof value !== "string" || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) return null;
  return value;
}

export function normalizeGoPlus(fields: Record<string, unknown>): {
  decision: "Reject" | "Pending";
  findings: Finding[];
} {
  const findings: Finding[] = [];
  let rejected = false;
  for (const name of critical) {
    const value = flag(fields[name]);
    if (value === true) rejected = true;
    findings.push({ field: name, value, reason: value === null ? "Unknown flag" : value ? "Critical eligibility finding" : "Clear" });
  }
  for (const name of taxes) {
    const value = fraction(fields[name]);
    const full = value !== null && /^1(?:\.0+)?$/.test(value);
    if (full) rejected = true;
    findings.push({ field: name, value, reason: value === null ? "Unknown or malformed tax fraction" : full ? "Entire path taxed" : "Tax policy unresolved" });
  }
  for (const name of privileges) {
    const value = flag(fields[name]);
    findings.push({ field: name, value, reason: value === null ? "Unknown flag or coverage" : "Privilege or inspection policy unresolved" });
  }
  for (const name of ["owner_address", "is_in_dex", "dex"] as const) {
    const value = name === "is_in_dex" ? flag(fields[name]) : fields[name] ?? null;
    findings.push({ field: name, value, reason: value === null ? "Unknown context" : "Context recorded" });
  }
  return { decision: rejected ? "Reject" : "Pending", findings };
}
