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
    call: (contractId, method, args, gas, attachedDeposit) =>
      transport.call(contractId, method, args, gas, attachedDeposit),
  };
}

/** Read-only EVM calls used for evidence; every one is safe to retry. */
export interface ReadOnlyEvmRpc {
  chainId(): Promise<bigint>;
  blockNumber(): Promise<bigint>;
  /** Block timestamp in seconds. */
  blockTimestamp(blockNumber: bigint): Promise<bigint>;
  /** `eth_call` pinned to `block` when given. */
  call(tx: { to: string; data: string }, block?: bigint): Promise<string>;
}

/** Retries read-only EVM calls on transient failures (rate limits, gateway and network errors). */
export function withEvmReadRetries(
  rpc: ReadOnlyEvmRpc,
  opts: Partial<BackoffOptions> = {},
): ReadOnlyEvmRpc {
  const backoff = { ...DEFAULT_VIEW_RETRY, ...opts, shouldRetry: isTransientRpcError };
  const retry = <T>(fn: () => Promise<T>) => withBackoff(fn, backoff);
  return {
    chainId: () => retry(() => rpc.chainId()),
    blockNumber: () => retry(() => rpc.blockNumber()),
    blockTimestamp: (n) => retry(() => rpc.blockTimestamp(n)),
    call: (tx, block) => retry(() => rpc.call(tx, block)),
  };
}
