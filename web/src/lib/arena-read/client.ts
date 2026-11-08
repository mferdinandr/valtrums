import type { SearchInput } from "./search-controller";

/** Read tools the web proxy forwards. Anything else is refused before leaving the browser. */
export const READ_TOOLS = [
  "list_battles",
  "inspect_battle",
  "inspect_round",
  "inspect_audit",
  "inspect_positions",
  "inspect_entitlements",
  "inspect_payouts",
  "inspect_escrow",
] as const;
export type ReadToolName = (typeof READ_TOOLS)[number];

export const SEARCH_KEYS = ["q", "mode", "status", "community", "cursor", "limit"] as const;

export interface ReadEnvelope<T> {
  tool: string;
  network: string;
  source: { kind: "live" | "recorded" | "fixture"; name: string };
  observedAt: string | null;
  freshness: "fresh" | "stale" | "unknown";
  limitations: string[];
  data: T;
}

export interface BattleSummary {
  battleId: number;
  mode: string;
  creator: string;
  protocolCreated: boolean;
  status: "open" | "locked" | "decided";
  winner: number | null;
  communities: Array<{ index: number; representation: string; tokenAddress: string; chainId: string }>;
}

export interface BattlePage {
  items: BattleSummary[];
  nextCursor: string | null;
  truncated: boolean;
}

/** Only known, non-empty search keys reach the backend; the text is trimmed and capped. */
export function buildSearchQuery(input: SearchInput): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of SEARCH_KEYS) {
    const raw = input[key];
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (!value) continue;
    params.set(key, key === "q" ? value.slice(0, 64) : value);
  }
  return params;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function fetchReadTool<T>(
  tool: ReadToolName,
  params: URLSearchParams,
  opts: { signal?: AbortSignal; session?: string; fetch?: FetchLike } = {},
): Promise<ReadEnvelope<T>> {
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const query = params.toString();
  const res = await doFetch(`/api/arena/tools/${tool}${query ? `?${query}` : ""}`, {
    method: "GET",
    cache: "no-store",
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.session ? { headers: { authorization: `Bearer ${opts.session}` } } : {}),
  });
  const body = (await res.json().catch(() => null)) as (ReadEnvelope<T> & { error?: string }) | null;
  if (!res.ok || !body) throw new Error(body?.error ?? `read failed with status ${res.status}`);
  return body;
}

export const fetchBattlePage = (input: SearchInput, signal: AbortSignal, fetchImpl?: FetchLike) =>
  fetchReadTool<BattlePage>("list_battles", buildSearchQuery(input), { signal, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
