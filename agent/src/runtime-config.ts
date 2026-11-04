import { DEFAULT_BASELINE_PATH } from "./baseline.js";
import { isAddress, normalizeAddress } from "./evm-abi.js";

export interface RuntimeConfig {
  /** Seconds between passes (audit, lock, settlement, price sampling). */
  intervalSecs: number;
  /** Seconds between watchdog checks. */
  watchdogIntervalSecs: number;
  baselinePath: string;
  executionMode: ExecutionMode;
  /** Slippage tolerance for on-chain swap steps, in basis points. */
  slippageBps: number;
  /** Seconds a dispatched step may stay unfinished before it is flagged. */
  stepTimeoutSecs: number;
  /** Present only with EXECUTION_MODE=foreign. */
  foreign?: ForeignRuntimeConfig;
}

export type ExecutionMode = "mock" | "onchain" | "foreign";

export interface ForeignRuntimeConfig {
  /** Secret-bearing (providers embed API keys): never log or print it. */
  rpcUrl: string;
  chainId: bigint;
  confirmations: number;
  /** USDC on the foreign chain, lowercase 0x. */
  usdc: string;
  /** NEAR token account id to EVM token address (lowercase 0x). */
  tokenMap: Map<string, string>;
  feeTier: number;
  /** Uniswap V3 QuoterV2, lowercase 0x. */
  quoter: string;
}

const FEE_TIERS = [100, 500, 3000, 10000];

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is required when EXECUTION_MODE=foreign`);
  return v;
}

function envAddress(env: Record<string, string | undefined>, name: string): string {
  const v = requiredEnv(env, name);
  if (!isAddress(v)) throw new Error(`${name} must be a 20-byte hex address`);
  return normalizeAddress(v);
}

/** Parse and validate the FOREIGN_* settings. Messages name variables, never values. */
export function loadForeignConfig(env: Record<string, string | undefined>): ForeignRuntimeConfig {
  const rpcUrl = requiredEnv(env, "FOREIGN_RPC_URL");
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new Error("FOREIGN_RPC_URL must be a valid URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("FOREIGN_RPC_URL must use https (http is only accepted for localhost)");
  }
  const chainRaw = requiredEnv(env, "FOREIGN_CHAIN_ID");
  if (!/^[1-9][0-9]*$/.test(chainRaw)) throw new Error("FOREIGN_CHAIN_ID must be a positive integer");
  const confRaw = env.FOREIGN_CONFIRMATIONS?.trim() || "3";
  const confirmations = Number(confRaw);
  if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 100) {
    throw new Error("FOREIGN_CONFIRMATIONS must be an integer between 1 and 100");
  }
  const feeRaw = env.FOREIGN_FEE_TIER?.trim() || "3000";
  const feeTier = Number(feeRaw);
  if (!FEE_TIERS.includes(feeTier)) {
    throw new Error(`FOREIGN_FEE_TIER must be one of ${FEE_TIERS.join(", ")}`);
  }
  const usdc = envAddress(env, "FOREIGN_USDC_ADDRESS");
  const quoter = envAddress(env, "FOREIGN_QUOTER_ADDRESS");

  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredEnv(env, "FOREIGN_TOKEN_MAP"));
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("FOREIGN_TOKEN_MAP")) throw err;
    throw new Error("FOREIGN_TOKEN_MAP must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("FOREIGN_TOKEN_MAP must be a JSON object of NEAR token id to EVM address");
  }
  const tokenMap = new Map<string, string>();
  const seen = new Set<string>();
  for (const [nearId, addr] of Object.entries(parsed)) {
    if (!nearId || typeof addr !== "string" || !isAddress(addr)) {
      throw new Error(`FOREIGN_TOKEN_MAP entry "${nearId}" must map to a 20-byte hex address`);
    }
    const normalized = normalizeAddress(addr);
    if (normalized === usdc) throw new Error(`FOREIGN_TOKEN_MAP entry "${nearId}" maps to the USDC address`);
    if (seen.has(normalized)) throw new Error(`FOREIGN_TOKEN_MAP maps two tokens to the address of "${nearId}"`);
    seen.add(normalized);
    tokenMap.set(nearId, normalized);
  }
  if (tokenMap.size === 0) throw new Error("FOREIGN_TOKEN_MAP must contain at least one token");

  return { rpcUrl, chainId: BigInt(chainRaw), confirmations, usdc, tokenMap, feeTier, quoter };
}

function positiveInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function loadRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const mode = env.EXECUTION_MODE?.trim() || "mock";
  if (mode !== "mock" && mode !== "onchain" && mode !== "foreign") {
    throw new Error(`EXECUTION_MODE must be "mock", "onchain" or "foreign"`);
  }
  const slippageRaw = env.EXECUTION_SLIPPAGE_BPS?.trim();
  const slippageBps = slippageRaw ? Number(slippageRaw) : 500;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 9999) {
    throw new Error("EXECUTION_SLIPPAGE_BPS must be an integer between 0 and 9999");
  }
  return {
    intervalSecs: positiveInt(env, "AGENT_INTERVAL_SECS", 30),
    watchdogIntervalSecs: positiveInt(env, "WATCHDOG_INTERVAL_SECS", 3600),
    baselinePath: env.BASELINE_STORE_PATH?.trim() || DEFAULT_BASELINE_PATH,
    executionMode: mode,
    slippageBps,
    stepTimeoutSecs: positiveInt(env, "STEP_TIMEOUT_SECS", 600),
    ...(mode === "foreign" ? { foreign: loadForeignConfig(env) } : {}),
  };
}
