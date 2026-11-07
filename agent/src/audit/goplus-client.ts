import { withBackoff } from "../retry.js";
import { isRateLimited, type GoPlusQuery, type RawGoPlusResponse } from "./goplus.js";

export const GOPLUS_BASE_URL = "https://api.gopluslabs.io";
export const GOPLUS_PROVIDER_VERSION = "token_security/v1";

export interface GoPlusClientOptions {
  baseUrl?: string;
  /**
   * Optional credential from the git-ignored environment (GOPLUS_ACCESS_TOKEN). The endpoint works
   * without one (rate limited); the header is sent only when a token is set. The `Authorization`
   * scheme is an assumption and is NOT verified. Never logged or stored in evidence.
   */
  accessToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  /** Total attempts for a rate-limited response (default 3). */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Queries Token Security for the audited subject (the reference token for a mapped asset) and
 * keeps the untouched response text for hashing. Rate-limited answers are retried a bounded
 * number of times with backoff; if still limited, or on any error, the returned evidence is
 * non-clean and normalization yields Pending, never a pass or a reject.
 *
 * Verification status: exercised against fixtures only. Unauthenticated requests were reported to
 * work for chain 4663 on 2026-11-07 (outside this repo's tests); testnet 46630 is not covered.
 */
export async function fetchGoPlusTokenSecurity(
  query: GoPlusQuery,
  opts: GoPlusClientOptions = {},
): Promise<RawGoPlusResponse> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl ?? GOPLUS_BASE_URL}/api/v1/token_security/${encodeURIComponent(
    query.chainId,
  )}?contract_addresses=${encodeURIComponent(query.token)}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.accessToken) headers.authorization = opts.accessToken;
  const now = opts.now ?? (() => new Date());

  const once = async (): Promise<RawGoPlusResponse> => {
    const queriedAt = now().toISOString();
    let httpStatus = 0;
    let rawText = "";
    try {
      const res = await doFetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
      httpStatus = res.status;
      rawText = await res.text();
    } catch {
      return { query, providerVersion: GOPLUS_PROVIDER_VERSION, queriedAt, httpStatus: 0, rawText: "", body: null };
    }
    let body: unknown = null;
    try {
      body = JSON.parse(rawText);
    } catch {
      body = null;
    }
    return { query, providerVersion: GOPLUS_PROVIDER_VERSION, queriedAt, httpStatus, rawText, body };
  };

  class RateLimited extends Error {
    constructor(readonly last: RawGoPlusResponse) {
      super("rate limited");
    }
  }
  try {
    return await withBackoff(
      async () => {
        const r = await once();
        if (isRateLimited(r.httpStatus, r.body)) throw new RateLimited(r);
        return r;
      },
      {
        attempts: opts.attempts ?? 3,
        baseDelayMs: opts.baseDelayMs ?? 1_000,
        maxDelayMs: opts.maxDelayMs ?? 8_000,
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
        shouldRetry: (e) => e instanceof RateLimited,
      },
    );
  } catch (e) {
    if (e instanceof RateLimited) return e.last; // still limited: normalization holds it Pending
    throw e;
  }
}
