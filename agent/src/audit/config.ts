import { isAddress, normalizeAddress } from "../evm-abi.js";
import { DEFAULT_EVIDENCE_TTL_SECONDS } from "./policy.js";
import { validateStablecoins, type PoolConfig } from "./lp-fetcher.js";
import { validateRegistry, type ReferenceEntry } from "./reference.js";

export interface AuditConfig {
  ttlSeconds: number;
  registry: ReferenceEntry[];
  stablecoins: Map<string, number>;
  pools: PoolConfig[];
  /** Secret: never log or serialize. */
  goplusAccessToken: string | undefined;
  /** Read-only Robinhood mainnet (4663) RPC, separate from the testnet FOREIGN_RPC_URL. May embed a key: never log it. */
  referenceRpcUrl: string;
}

function json(env: Record<string, string | undefined>, name: string, fallback: string): unknown {
  const raw = env[name]?.trim() || fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

/**
 * Settings for the lifecycle audit pass. Returns null unless AUDIT_ENABLED=true.
 * The evidence TTL defaults to 600 seconds (AUDIT_EVIDENCE_TTL_SECS) and must exceed twice the
 * pass interval so approvals are refreshed before they can lapse. Messages name variables only.
 */
export function loadAuditConfig(
  env: Record<string, string | undefined>,
  passIntervalSecs: number,
): AuditConfig | null {
  if (env.AUDIT_ENABLED?.trim() !== "true") return null;
  const ttlRaw = env.AUDIT_EVIDENCE_TTL_SECS?.trim();
  const ttlSeconds = ttlRaw ? Number(ttlRaw) : DEFAULT_EVIDENCE_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("AUDIT_EVIDENCE_TTL_SECS must be a positive integer");
  }
  if (ttlSeconds <= passIntervalSecs * 2) {
    throw new Error("AUDIT_EVIDENCE_TTL_SECS must exceed twice AGENT_INTERVAL_SECS");
  }
  const referenceRpcUrl = env.REFERENCE_RPC_URL?.trim();
  if (!referenceRpcUrl) throw new Error("REFERENCE_RPC_URL is required when AUDIT_ENABLED=true");
  let url: URL;
  try {
    url = new URL(referenceRpcUrl);
  } catch {
    throw new Error("REFERENCE_RPC_URL must be a valid URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("REFERENCE_RPC_URL must use https (http is only accepted for localhost)");
  }

  const regRaw = json(env, "AUDIT_REFERENCE_REGISTRY", "[]");
  if (!Array.isArray(regRaw)) throw new Error("AUDIT_REFERENCE_REGISTRY must be a JSON array");
  const registry = validateRegistry(
    regRaw.map((e: Record<string, unknown>) => ({
      chainId: String(e.chain_id),
      token: String(e.token),
      referenceChainId: String(e.reference_chain_id),
      referenceToken: String(e.reference_address),
    })),
  );

  const stableRaw = json(env, "AUDIT_STABLECOINS", "{}");
  if (typeof stableRaw !== "object" || stableRaw === null || Array.isArray(stableRaw)) {
    throw new Error("AUDIT_STABLECOINS must be a JSON object of address to decimals");
  }
  const stablecoins = validateStablecoins(stableRaw as Record<string, unknown>);

  const poolRaw = json(env, "AUDIT_LP_POOLS", "[]");
  if (!Array.isArray(poolRaw)) throw new Error("AUDIT_LP_POOLS must be a JSON array");
  const pools: PoolConfig[] = poolRaw.map((p: Record<string, unknown>) => {
    if (typeof p.pool !== "string" || !isAddress(p.pool) || (p.kind !== "v2" && p.kind !== "v3")) {
      throw new Error('AUDIT_LP_POOLS entries need a 20-byte "pool" address and kind "v2" or "v3"');
    }
    return { pool: normalizeAddress(p.pool), kind: p.kind };
  });

  return {
    ttlSeconds,
    registry,
    stablecoins,
    pools,
    goplusAccessToken: env.GOPLUS_ACCESS_TOKEN?.trim() || undefined,
    referenceRpcUrl,
  };
}
