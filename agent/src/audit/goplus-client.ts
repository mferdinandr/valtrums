import type { GoPlusQuery, RawGoPlusResponse } from "./goplus.js";

export const GOPLUS_BASE_URL = "https://api.gopluslabs.io";
export const GOPLUS_PROVIDER_VERSION = "token_security/v1";

export interface GoPlusClientOptions {
  baseUrl?: string;
  /** Provider credential from the git-ignored environment (GOPLUS_ACCESS_TOKEN); never logged or stored in evidence. */
  accessToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * Queries Token Security for the source-chain token (not its NEAR wrapper) and keeps the
 * untouched response text for hashing. Errors become evidence with a non-2xx status or
 * unparseable body, which normalization treats as Pending, never as a clean audit.
 *
 * Verification status: exercised against fixtures only. Robinhood testnet 46630 is not
 * covered by the unauthenticated endpoint (code 2022 on 2026-11-06); see docs/goplus-audit.md.
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
  const queriedAt = (opts.now ?? (() => new Date()))().toISOString();
  let httpStatus = 0;
  let rawText = "";
  try {
    const res = await doFetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    httpStatus = res.status;
    rawText = await res.text();
  } catch (e) {
    return { query, providerVersion: GOPLUS_PROVIDER_VERSION, queriedAt, httpStatus: 0, rawText: "", body: null };
  }
  let body: unknown = null;
  try {
    body = JSON.parse(rawText);
  } catch {
    body = null;
  }
  return { query, providerVersion: GOPLUS_PROVIDER_VERSION, queriedAt, httpStatus, rawText, body };
}
