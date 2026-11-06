import { createHash } from "node:crypto";
import type { HttpClient } from "./http.js";

/** Authenticated infrastructure inputs; these records are not cryptographic proofs. */
export interface AuditAsset { chainId: string; tokenAddress: string }
export type AuditDecision = "Pass" | "Pending" | "Reject";
export type EvidenceOrigin = "live" | "fixture";
export interface AuditPolicy { version: string; maxEvidenceAgeMs: number }
export interface AuditFinding { field: string; decision: AuditDecision; reason: string }
export interface Rational { numerator: bigint; denominator: bigint }
export interface BoundEvidence extends AuditAsset {
  observedAtMs: number;
  provider: string;
  origin: EvidenceOrigin;
}
export interface GoPlusEvidence extends BoundEvidence {
  available: boolean;
  rawResponse: unknown;
  responseHash: string;
  fields: Record<string, unknown> | null;
  unavailableReason?: string;
}
export interface LiquidityDepthEvidence extends BoundEvidence {
  /** Independent eligible-pool depth in USD, not token market capitalization. */
  valueUsd: string;
  poolIds: string[];
  blockHash: string;
}
export interface AuthorityEvidence extends BoundEvidence {
  /** Must be determined independently of a bare owner_address/renunciation claim. */
  active: boolean | "unknown";
  evidenceReference: string;
}
export interface ArenaAuditResult {
  decision: AuditDecision;
  asset: AuditAsset;
  policyVersion: string;
  findings: AuditFinding[];
  normalizedFlags: Record<string, boolean | null>;
  normalizedTaxes: Record<string, Rational | null>;
  goPlusResponseHash: string;
  /** Fixture evidence must never be presented as successful public-service integration. */
  origins: EvidenceOrigin[];
}

export const CRITICAL_FLAGS = ["is_honeypot", "cannot_sell_all", "cannot_buy"] as const;
export const DANGEROUS_PRIVILEGES = [
  "transfer_pausable", "owner_change_balance", "slippage_modifiable",
  "personal_slippage_modifiable", "is_blacklisted", "is_whitelisted",
] as const;
export type DangerousPrivilege = typeof DANGEROUS_PRIVILEGES[number];
export const STRICT_AUDIT_POLICY_VERSION = "arena-strict-5pct-zero-transfer-v1";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
export function normalizeAuditFlag(value: unknown): boolean | null {
  return value === "1" ? true : value === "0" ? false : null;
}
/** Bounded input size prevents adversarial exponent/precision allocation; no rounding. */
export function parseAuditDecimal(value: unknown): Rational | null {
  if (typeof value !== "string" || value.length > 120 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) return null;
  const [whole = "", fraction = ""] = value.split(".");
  return { numerator: BigInt(whole + fraction), denominator: 10n ** BigInt(fraction.length) };
}
function assetKey(asset: AuditAsset): string {
  if (!/^[1-9]\d{0,19}$/.test(asset.chainId) || !/^0x[0-9a-fA-F]{40}$/.test(asset.tokenAddress)) {
    throw new Error("Invalid source chain ID or EVM token address");
  }
  return `${asset.chainId}:${asset.tokenAddress.toLowerCase()}`;
}
function matches(a: AuditAsset, b: AuditAsset): boolean {
  try { return assetKey(a) === assetKey(b); } catch { return false; }
}
function isFresh(evidence: BoundEvidence, nowMs: number, policy: AuditPolicy): boolean {
  return Number.isSafeInteger(evidence.observedAtMs) && evidence.observedAtMs <= nowMs
    && nowMs - evidence.observedAtMs <= policy.maxEvidenceAgeMs
    && evidence.provider.length > 0 && ["fixture", "live"].includes(evidence.origin);
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

/** Network failures/unsupported source chains are explicit unavailable evidence, not Pass. */
export class GoPlusArenaClient {
  private readonly endpoint: string;
  constructor(private readonly http: HttpClient, private readonly options: {
    endpoint?: string;
    bearerToken?: string;
    origin?: EvidenceOrigin;
    now?: () => number;
  } = {}) {
    const endpoint = new URL(options.endpoint ?? "https://api.gopluslabs.io/api/v1/");
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("GoPlus endpoint must be HTTPS without URL credentials/query");
    }
    this.endpoint = endpoint.href.replace(/\/?$/, "/");
  }
  async audit(asset: AuditAsset): Promise<GoPlusEvidence> {
    assetKey(asset);
    const headers = this.options.bearerToken ? { Authorization: `Bearer ${this.options.bearerToken}` } : undefined;
    let rawResponse: unknown = null;
    let fields: Record<string, unknown> | null = null;
    let unavailableReason: string | undefined;
    try {
      const discovery = record(await this.http.getJson(`${this.endpoint}supported_chains?name=token_security`, headers));
      const chains = discovery?.result;
      if (discovery?.code !== 1 || !Array.isArray(chains)) {
        unavailableReason = "GoPlus supported-chain discovery was incomplete";
      } else if (!chains.some(c => {
        const row = record(c);
        // Official OpenAPI uses id; accept chain_id only when no conflicting id exists.
        if (!row) return false;
        if (row.id !== undefined && row.chain_id !== undefined && row.id !== row.chain_id) return false;
        return (row.id ?? row.chain_id) === asset.chainId;
      })) {
        unavailableReason = "GoPlus token-security chain coverage is unavailable";
      } else {
        rawResponse = await this.http.getJson(`${this.endpoint}token_security/${asset.chainId}?contract_addresses=${asset.tokenAddress.toLowerCase()}`, headers);
        const response = record(rawResponse);
        const result = record(response?.result);
        const entries = result ? Object.entries(result).filter(([address]) => address.toLowerCase() === asset.tokenAddress.toLowerCase()) : [];
        fields = entries.length === 1 ? record(entries[0]?.[1]) : null;
        if (response?.code !== 1 || !fields) {
          fields = null;
          unavailableReason = "GoPlus token-security response lacks the requested token";
        }
      }
    } catch {
      // Do not propagate provider error text: it can contain credential-bearing URLs.
      fields = null;
      unavailableReason = "GoPlus request failed";
    }
    return {
      ...asset, tokenAddress: asset.tokenAddress.toLowerCase(),
      provider: "goplus-token-security-v1", origin: this.options.origin ?? "live",
      observedAtMs: (this.options.now ?? Date.now)(), available: fields !== null,
      rawResponse, responseHash: hash(rawResponse), fields,
      ...(unavailableReason ? { unavailableReason } : {}),
    };
  }
}

/** Pre-lock eligibility only. Live price/LP falls must not trigger automatic halts. */
export function evaluateArenaAudit(input: {
  asset: AuditAsset;
  goPlus: GoPlusEvidence;
  liquidity: LiquidityDepthEvidence | null;
  authority?: Partial<Record<DangerousPrivilege, AuthorityEvidence>>;
  policy: AuditPolicy;
  nowMs: number;
}): ArenaAuditResult {
  const { asset, goPlus, liquidity, policy, nowMs } = input;
  assetKey(asset);
  if (!policy.version || !Number.isSafeInteger(policy.maxEvidenceAgeMs) || policy.maxEvidenceAgeMs < 1
    || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Explicit versioned freshness policy and valid clock required");
  const findings: AuditFinding[] = [];
  const flags: Record<string, boolean | null> = {};
  const taxes: Record<string, Rational | null> = {};
  const origins = new Set<EvidenceOrigin>([goPlus.origin]);
  const add = (field: string, decision: AuditDecision, reason: string) => findings.push({ field, decision, reason });
  const raw = record(goPlus.rawResponse);
  const rawResult = record(raw?.result);
  const rawMatches = rawResult ? Object.entries(rawResult).filter(([address]) => address.toLowerCase() === asset.tokenAddress.toLowerCase()) : [];
  const rawFields = rawMatches.length === 1 ? record(rawMatches[0]?.[1]) : null;
  const validSource = raw?.code === 1 && rawFields !== null && hash(rawFields) === hash(goPlus.fields)
    && matches(asset, goPlus) && isFresh(goPlus, nowMs, policy)
    && goPlus.available && goPlus.fields !== null && goPlus.responseHash === hash(goPlus.rawResponse);
  if (!validSource) {
    add("goplus", "Pending", "Missing, stale, mismatched or unavailable source-token evidence");
  } else {
    const values = goPlus.fields!;
    for (const field of CRITICAL_FLAGS) {
      const flag = normalizeAuditFlag(values[field]); flags[field] = flag;
      if (flag === true) add(field, "Reject", "Token fails the selected trading eligibility policy");
      else if (flag === null) add(field, "Pending", "Required critical flag is unknown");
    }
    for (const field of ["buy_tax", "sell_tax", "transfer_tax"]) {
      const value = parseAuditDecimal(values[field]);
      taxes[field] = value && value.numerator <= value.denominator ? value : null;
      if (!taxes[field]) add(field, "Pending", "Required tax fraction is missing or malformed");
      else if (field === "transfer_tax" ? value!.numerator !== 0n : value!.numerator * 20n > value!.denominator) {
        add(field, "Reject", field === "transfer_tax" ? "Transfer tax must be zero" : "Buy/sell tax exceeds 5%");
      }
    }
    for (const field of DANGEROUS_PRIVILEGES) {
      const flag = normalizeAuditFlag(values[field]); flags[field] = flag;
      if (flag === null) add(field, "Pending", "Required privilege capability is unknown");
      if (flag !== true) continue;
      const authority = input.authority?.[field];
      if (authority) origins.add(authority.origin);
      if (!authority || !matches(asset, authority) || !isFresh(authority, nowMs, policy)
        || !authority.evidenceReference || (authority.active !== true && authority.active !== false)) {
        add(field, "Pending", "Effective authority is not established by fresh independent evidence");
      } else if (authority.active === true) add(field, "Reject", "Dangerous effective admin authority is active");
      // False is acceptable only with independent source-bound evidence, never owner renunciation alone.
    }
    for (const field of ["is_open_source", "is_proxy", "is_mintable"]) {
      const flag = normalizeAuditFlag(values[field]); flags[field] = flag;
      if (flag === null) add(field, "Pending", "Required inspection context is unknown");
      if (field === "is_proxy" && flag === true) add(field, "Pending", "Proxy upgrade authority requires an explicit admission policy");
      if (field === "is_mintable" && flag === true) add(field, "Pending", "Mint-capability admissibility is not yet resolved by policy");
    }
  }
  if (!liquidity || !matches(asset, liquidity) || !isFresh(liquidity, nowMs, policy)
    || liquidity.provider === goPlus.provider || !liquidity.blockHash || !liquidity.poolIds.length || new Set(liquidity.poolIds).size !== liquidity.poolIds.length
    || liquidity.poolIds.some(p => !p)) {
    add("liquidity", "Pending", "Independent, fresh, source-bound eligible-pool evidence is required");
  } else {
    origins.add(liquidity.origin);
    const value = parseAuditDecimal(liquidity.valueUsd);
    if (!value) add("liquidity", "Pending", "Independent LP valuation is malformed");
    else if (value.numerator <= 10_000n * value.denominator) add("liquidity", "Reject", "Independent LP depth must exceed USD 10000");
  }
  return {
    decision: findings.some(f => f.decision === "Reject") ? "Reject" : findings.length ? "Pending" : "Pass",
    asset, policyVersion: policy.version, findings, normalizedFlags: flags, normalizedTaxes: taxes,
    goPlusResponseHash: goPlus.responseHash, origins: [...origins],
  };
}
