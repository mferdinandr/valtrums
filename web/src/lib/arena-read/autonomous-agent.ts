import { generateKey } from "near-kit";
import { gasUnits, rpcView, type AgentStrategy } from "./agent-grant";
import { readJoinableAssets } from "./open-arena";

/**
 * Autonomous player agent, web side (docs/player-agents.md). The agent has its own NEAR account and its own token
 * balance. This module builds everything the page needs without any server holding a key: the key pair is made in
 * the browser, the owner funds the account from their own wallet, and the status is read from the chain.
 */

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const AGENT_KEY_ENV = "PLAYER_KEY_MY_AGENT";
const TOKEN_DECIMALS = 18;
/** Upper bound of the NEP-145 storage deposit that registers the agent on a token; the token refunds the excess. */
export const STORAGE_DEPOSIT_YOCTO = "12500000000000000000000";
const ONE_YOCTO = "1";
const YOCTO = 10n ** 24n;
const RECENT_BATTLES = 8;

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export interface AgentKey {
  /** The implicit NEAR account of the key: the 64-character hex of the public key. Exists once it is funded. */
  account: string;
  publicKey: string;
  /** Secret. Shown to the owner once; never sent anywhere or stored by the page. */
  secretKey: string;
}

/** A new agent key, generated in this browser. */
export function newAgentKey(): AgentKey {
  const key = generateKey();
  return { account: hex(key.publicKey.data), publicKey: key.publicKey.toString(), secretKey: key.secretKey };
}

export interface AgentSettings {
  strategy: AgentStrategy;
  /** The owner's account that receives surplus tokens, or "" for no sweep. */
  sweepTo: string;
  /** Whole tokens each token balance keeps as working capital when sweeping. */
  keepWhole: number;
}

/** The config file for `pnpm -C agent player:auto`. It holds no key, only the name of the environment variable. */
export function buildAutonomousConfig(account: string, settings: AgentSettings): { agents: Array<Record<string, unknown>> } {
  return {
    agents: [
      {
        account,
        // A hint in the prompt: NEAR AI decides every play (no rule-based path).
        style: settings.strategy,
        keyEnv: AGENT_KEY_ENV,
        ...(settings.sweepTo ? { sweepTo: settings.sweepTo, keepWhole: settings.keepWhole } : {}),
      },
    ],
  };
}

/**
 * The command that runs the agent. Keys are passed by environment variable, never as arguments. NEAR AI decides every
 * play, so `NEAR_AI_API_KEY` is required.
 */
export const runCommand = (configFile: string): string =>
  `ARENA_CONTRACT_ID=<arena> NEAR_AI_API_KEY=<near ai key> ${AGENT_KEY_ENV}=<secret key> pnpm -C agent player:auto --config ${configFile} --live`;

/** `"0.3"` NEAR to a yocto string; null when the text is not a positive amount with at most 24 decimals. */
export function nearToYocto(text: string): string | null {
  const m = /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,24}))?$/.exec(text.trim());
  if (!m) return null;
  const yocto = BigInt(m[1]!) * YOCTO + BigInt((m[2] ?? "").padEnd(24, "0") || "0");
  return yocto > 0n ? yocto.toString() : null;
}

/** Whole tokens to base units; null unless a positive whole number. */
export function tokensToBase(whole: string): string | null {
  if (!/^[1-9][0-9]{0,11}$/.test(whole.trim())) return null;
  return (BigInt(whole.trim()) * 10n ** BigInt(TOKEN_DECIMALS)).toString();
}

export interface WalletTransaction {
  receiverId: string;
  actions: Array<
    | { type: "Transfer"; params: { deposit: string } }
    | { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } }
  >;
}

/** Sends NEAR (gas and storage) from the owner's wallet to the agent account. */
export function fundNearTransaction(agent: string, yocto: string): WalletTransaction {
  return { receiverId: agent, actions: [{ type: "Transfer", params: { deposit: yocto } }] };
}

/** Registers the agent on the token contract and sends it `base` units, in one wallet transaction. */
export function fundTokenTransaction(token: string, agent: string, base: string): WalletTransaction {
  return {
    receiverId: token,
    actions: [
      { type: "FunctionCall", params: { methodName: "storage_deposit", args: { account_id: agent, registration_only: true }, gas: gasUnits("10"), deposit: STORAGE_DEPOSIT_YOCTO } },
      { type: "FunctionCall", params: { methodName: "ft_transfer", args: { receiver_id: agent, amount: base }, gas: gasUnits("30"), deposit: ONE_YOCTO } },
    ],
  };
}

export interface AgentTokenBalance {
  representation: string;
  base: string;
}
export interface AgentPlay {
  battleId: number;
  community: number;
  representation: string;
  /** Base units the arena holds for the agent in this community. */
  amount: string;
}
export interface AgentStatus {
  /** NEAR balance in yocto, or null while the account does not exist yet (not funded). */
  nearYocto: string | null;
  tokens: AgentTokenBalance[];
  plays: AgentPlay[];
}

async function nearBalance(rpcUrl: string, account: string, doFetch: FetchLike): Promise<string | null> {
  const res = await doFetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "valtrum", method: "query", params: { request_type: "view_account", finality: "optimistic", account_id: account } }),
  });
  if (!res.ok) throw new Error(`RPC error ${res.status}`);
  const body = (await res.json()) as { result?: { amount?: string }; error?: unknown };
  return body.result?.amount ?? null; // an unknown account is an error object: not funded yet
}

/** Everything the agent holds and has played, read from the chain: NEAR, joinable tokens and recent positions. */
export async function readAgentStatus(rpcUrl: string, arena: string, account: string, doFetch: FetchLike = (u, i) => fetch(u, i)): Promise<AgentStatus> {
  const [nearYocto, assets] = await Promise.all([nearBalance(rpcUrl, account, doFetch), readJoinableAssets(rpcUrl, arena, doFetch)]);
  const tokens: AgentTokenBalance[] = await Promise.all(
    assets.map(async (a) => ({
      representation: a.representation,
      base: (await rpcView<string>(rpcUrl, a.representation, "ft_balance_of", { account_id: account }, doFetch).catch(() => null)) ?? "0",
    })),
  );
  const count = Number((await rpcView<string | number>(rpcUrl, arena, "get_lifecycle_battle_count", {}, doFetch)) ?? 0);
  const plays: AgentPlay[] = [];
  for (let id = count; id >= 1 && id > count - RECENT_BATTLES; id--) {
    const battle = await rpcView<{ communities?: Array<{ representation: string }> }>(rpcUrl, arena, "get_lifecycle_battle", { battle_id: id }, doFetch).catch(() => null);
    for (const [community, c] of (battle?.communities ?? []).entries()) {
      const pos = await rpcView<{ amount?: string }>(rpcUrl, arena, "get_lifecycle_position", { battle_id: id, community, account }, doFetch).catch(() => null);
      if (pos?.amount && pos.amount !== "0") plays.push({ battleId: id, community, representation: c.representation, amount: pos.amount });
    }
  }
  return { nearYocto, tokens, plays };
}
