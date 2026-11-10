import { gasUnits, rpcView } from "./agent-grant";

/**
 * Client of the faucet contract (`contracts/faucet`). Everything is read straight from the contract and the token
 * contracts over RPC, so no service has to be running; a claim is a transaction the user's own wallet signs.
 */
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Upper bound attached to `claim` for the claim record; the contract refunds what it does not use. */
export const CLAIM_DEPOSIT_YOCTO = "10000000000000000000000";
export const CLAIM_GAS_TGAS = "140";
/** Claims per transaction: each carries 140 Tgas and a transaction holds at most 300, so two fit. */
export const CLAIMS_PER_TRANSACTION = 2;
/** The faucet's tokens have 18 decimals, like the mock tokens they are backed by. */
export const FAUCET_DECIMALS = 18;

export interface FaucetEntry {
  token: string;
  symbol: string;
  /** Base units per claim. */
  amount: string;
  /** Base units the faucet still holds. */
  stock: string;
  /** True when the faucet holds at least one claim's worth. */
  inStock: boolean;
  /** Milliseconds until this account can claim again; 0 when it can now (or when signed out). */
  cooldownRemainingMs: number;
  /** What is left of today's budget, or null when the token has no daily bound. */
  budgetLeft: string | null;
  canClaim: boolean;
}

export interface FaucetState {
  paused: boolean;
  cooldownSecs: number;
  tokens: FaucetEntry[];
}

interface TokenView { token: string; symbol: string; amount: string; daily_budget: string; budget_left: string | null }
interface ClaimStatusView { last_claim_ns: string | null; next_claim_ns: string; can_claim: boolean }
interface ConfigView { paused: boolean; cooldown_secs: string }

const NS_PER_MS = 1_000_000n;

/** Reads the faucet's offer, its stock and, when `account` is given, that account's cooldowns. */
export async function readFaucet(rpcUrl: string, contract: string, account: string | null, nowMs: number, doFetch?: FetchLike): Promise<FaucetState> {
  const [config, tokens] = await Promise.all([
    rpcView<ConfigView>(rpcUrl, contract, "get_config", {}, doFetch),
    rpcView<TokenView[]>(rpcUrl, contract, "get_tokens", {}, doFetch),
  ]);
  if (!config || !tokens) throw new Error("the faucet contract did not answer");
  const entries = await Promise.all(
    tokens.map(async (t): Promise<FaucetEntry> => {
      const [balance, status] = await Promise.all([
        rpcView<string>(rpcUrl, t.token, "ft_balance_of", { account_id: contract }, doFetch),
        account ? rpcView<ClaimStatusView>(rpcUrl, contract, "get_claim_status", { account_id: account, token: t.token }, doFetch) : Promise.resolve(null),
      ]);
      const stock = BigInt(balance ?? "0");
      const wait = status ? Number(BigInt(status.next_claim_ns) / NS_PER_MS) - nowMs : 0;
      const cooldownRemainingMs = status && !status.can_claim && wait > 0 ? wait : 0;
      const inStock = stock >= BigInt(t.amount);
      const budgetOk = t.budget_left === null || BigInt(t.budget_left) >= BigInt(t.amount);
      return {
        token: t.token, symbol: t.symbol, amount: t.amount, stock: stock.toString(), inStock,
        cooldownRemainingMs, budgetLeft: t.budget_left, canClaim: !config.paused && inStock && budgetOk && cooldownRemainingMs === 0,
      };
    }),
  );
  return { paused: config.paused, cooldownSecs: Number(config.cooldown_secs), tokens: entries };
}

/**
 * The reviewed call a wallet signs for one or two claims. The claimer is always the signer; no argument names a
 * recipient. Several claims in one transaction are atomic: all succeed or none does.
 */
export function buildClaimCall(contract: string, tokens: string | readonly string[]) {
  const list = typeof tokens === "string" ? [tokens] : [...tokens];
  if (list.length < 1 || list.length > CLAIMS_PER_TRANSACTION) throw new Error(`a transaction carries 1 to ${CLAIMS_PER_TRANSACTION} claims`);
  return {
    receiverId: contract,
    actions: list.map((token) => ({
      type: "FunctionCall" as const,
      params: { methodName: "claim", args: { token }, gas: gasUnits(CLAIM_GAS_TGAS), deposit: CLAIM_DEPOSIT_YOCTO },
    })),
  };
}

/** Splits tokens into the groups that share one wallet approval. */
export function claimBatches<T>(tokens: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < tokens.length; i += CLAIMS_PER_TRANSACTION) out.push(tokens.slice(i, i + CLAIMS_PER_TRANSACTION));
  return out;
}

/** "23 h 59 min" for a cooldown, or "now" when it is over. */
export function formatWait(ms: number): string {
  if (!(ms > 0)) return "now";
  const minutes = Math.ceil(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** Why a token cannot be claimed right now, or null when it can. */
export function unavailableReason(e: FaucetEntry, paused: boolean): string | null {
  if (paused) return "The faucet is paused.";
  if (e.cooldownRemainingMs > 0) return `Already claimed. Next claim in ${formatWait(e.cooldownRemainingMs)}.`;
  if (!e.inStock) return "The faucet has run out of this token.";
  if (e.budgetLeft !== null && BigInt(e.budgetLeft) < BigInt(e.amount)) return "Today's budget for this token is used up. Try again tomorrow.";
  return null;
}
