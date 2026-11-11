import { rpcView } from "./agent-grant";
import { FAUCET_DECIMALS } from "./faucet";

/**
 * What the connected account holds: its NEAR and the balance of every token the faucet offers. Everything is a
 * plain RPC read, so no service has to be running and no key is involved.
 */
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const NEAR_DECIMALS = 24;
export { FAUCET_DECIMALS as TOKEN_DECIMALS };

export interface TokenBalance {
  token: string;
  symbol: string;
  /** Base units. "0" for an account that never held the token. */
  balance: string;
}

export interface AccountBalances {
  /** yoctoNEAR; "0" when the account does not exist yet. */
  near: string;
  tokens: TokenBalance[];
}

/** The account's NEAR balance in yocto, or "0" when the account does not exist on chain. */
export async function readNearBalance(rpcUrl: string, account: string, doFetch: FetchLike = (u, i) => fetch(u, i)): Promise<string> {
  const res = await doFetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "valtrum", method: "query", params: { request_type: "view_account", finality: "optimistic", account_id: account } }),
  });
  if (!res.ok) throw new Error(`RPC error ${res.status}`);
  const body = (await res.json()) as { result?: { amount?: string; error?: string }; error?: { message?: string } };
  if (body.result?.amount) return body.result.amount;
  // A missing account is a zero balance, not a failure.
  if (body.result?.error?.includes("does not exist") || body.error?.message?.includes("does not exist")) return "0";
  throw new Error(body.result?.error ?? body.error?.message ?? "RPC read failed");
}

/** Reads the NEAR balance and the balance of each faucet token for `account`. */
export async function readBalances(rpcUrl: string, faucet: string, account: string, doFetch?: FetchLike): Promise<AccountBalances> {
  const [near, offered] = await Promise.all([
    readNearBalance(rpcUrl, account, doFetch),
    rpcView<Array<{ token: string; symbol: string }>>(rpcUrl, faucet, "get_tokens", {}, doFetch),
  ]);
  if (!offered) throw new Error("the faucet contract did not answer");
  const tokens = await Promise.all(
    offered.map(async (t): Promise<TokenBalance> => {
      const balance = await rpcView<string>(rpcUrl, t.token, "ft_balance_of", { account_id: account }, doFetch);
      return { token: t.token, symbol: t.symbol, balance: balance ?? "0" };
    }),
  );
  return { near, tokens };
}
