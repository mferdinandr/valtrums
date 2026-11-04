import { DEFAULT_BASELINE_PATH } from "./baseline.js";

export interface RuntimeConfig {
  /** Seconds between passes (audit, lock, settlement, price sampling). */
  intervalSecs: number;
  /** Seconds between watchdog checks. */
  watchdogIntervalSecs: number;
  baselinePath: string;
  executionMode: "mock";
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
  if (mode !== "mock") {
    throw new Error(`EXECUTION_MODE "${mode}" is not available in this build, use "mock"`);
  }
  return {
    intervalSecs: positiveInt(env, "AGENT_INTERVAL_SECS", 30),
    watchdogIntervalSecs: positiveInt(env, "WATCHDOG_INTERVAL_SECS", 3600),
    baselinePath: env.BASELINE_STORE_PATH?.trim() || DEFAULT_BASELINE_PATH,
    executionMode: "mock",
  };
}
