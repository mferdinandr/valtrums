export interface BackoffOptions {
  /** Total attempts including the first. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  /** Return false to stop retrying and rethrow at once. Defaults to always retrying. */
  shouldRetry?: (error: unknown) => boolean;
}

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Run `fn`, retrying failures with exponential backoff (base * 2^n, capped). Rethrows the last error. */
export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (opts.shouldRetry && !opts.shouldRetry(err)) throw err;
      if (attempt < opts.attempts - 1) {
        await sleep(Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs));
      }
    }
  }
  throw lastError;
}
