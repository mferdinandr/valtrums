import { DEFAULT_BASELINE_PATH } from "./baseline.js";

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
}

export type ExecutionMode = "mock" | "onchain";

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
  if (mode !== "mock" && mode !== "onchain") {
    throw new Error(`EXECUTION_MODE must be "mock" or "onchain"`);
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
  };
}
