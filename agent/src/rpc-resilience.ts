import { withBackoff, type BackoffOptions } from "./retry.js";
import type { NearTransport } from "./near-client.js";

const TRANSIENT_PATTERNS = [
  /\b429\b/,
  /too many requests/i,
  /\b50[0234]\b/,
  /bad gateway|service unavailable|gateway time-?out/i,
  /rate.?limit/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/,
  /fetch failed|network error|socket hang up|timed? ?out/i,
];

/**
 * True for failures worth retrying: rate limits, gateway errors and network trouble.
 * Contract errors (a panic message from the arena) are not transient and must surface at once.
 */
export function isTransientRpcError(error: unknown): boolean {
  const text =
    error instanceof Error ? `${error.name} ${error.message} ${String(error.cause ?? "")}` : String(error);
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
}

export const DEFAULT_VIEW_RETRY: Omit<BackoffOptions, "sleep"> = {
  attempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
};

/**
 * Retries read-only calls on transient failures. Transactions pass through untouched: the agent
 * rebuilds its work from on-chain state on the next pass, and a blind resend could repeat an action.
 */
export function withViewRetries(
  transport: NearTransport,
  opts: Partial<BackoffOptions> = {},
  onRetry?: (error: unknown) => void,
): NearTransport {
  const backoff = { ...DEFAULT_VIEW_RETRY, ...opts };
  return {
    view: <T>(contractId: string, method: string, args: object) =>
      withBackoff(() => transport.view<T>(contractId, method, args), {
        ...backoff,
        shouldRetry: (error) => {
          const transient = isTransientRpcError(error);
          if (transient) onRetry?.(error);
          return transient;
        },
      }),
    call: (contractId, method, args, gas) => transport.call(contractId, method, args, gas),
  };
}
