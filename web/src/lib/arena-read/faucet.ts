/** Client side of the testnet faucet (`/api/faucet/*`, proxied to the faucet service). */
export interface FaucetTokenStatus {
  symbol: string;
  representation: string;
  amount: string;
  cooldownRemainingMs: number;
  available: boolean;
}
export interface FaucetStatus {
  account: string;
  live: boolean;
  tokens: FaucetTokenStatus[];
}
export interface FaucetClaim {
  symbol: string;
  status: "sent" | "dry_run" | "cooldown" | "empty" | "hourly_limit" | "error";
  amount: string;
  txHash?: string;
  retryAfterMs?: number;
  message?: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function call<T>(path: string, token: string, init: RequestInit, doFetch: FetchLike): Promise<T> {
  const res = await doFetch(`/api/faucet/${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, cache: "no-store" });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !body) throw new Error(body?.error ?? `faucet error ${res.status}`);
  return body;
}

export const fetchFaucetStatus = (token: string, doFetch: FetchLike = (u, i) => fetch(u, i)): Promise<FaucetStatus> => call<FaucetStatus>("status", token, { method: "GET" }, doFetch);

export async function claimFaucet(token: string, symbols?: readonly string[], doFetch: FetchLike = (u, i) => fetch(u, i)): Promise<{ live: boolean; results: FaucetClaim[] }> {
  return call("claim", token, { method: "POST", body: JSON.stringify(symbols && symbols.length > 0 ? { tokens: symbols } : {}) }, doFetch);
}

/** "23 h 59 min" for a cooldown, or "now" when it is over. */
export function formatWait(ms: number): string {
  if (!(ms > 0)) return "now";
  const minutes = Math.ceil(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** What to tell the user for one claim result. */
export function claimMessage(r: FaucetClaim): string {
  switch (r.status) {
    case "sent": return "Sent to your account.";
    case "dry_run": return "Dry run: the faucet is not live, nothing was sent.";
    case "cooldown": return `Already claimed. Try again in ${formatWait(r.retryAfterMs ?? 0)}.`;
    case "empty": return "The faucet has run out of this token.";
    case "hourly_limit": return "The faucet is busy. Try again later.";
    default: return `Could not send: ${r.message ?? "unknown error"}.`;
  }
}
