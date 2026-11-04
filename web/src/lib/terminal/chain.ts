// Chain-facing port of the terminal: reads needed to validate an intent and the sender that submits transactions.
// A deterministic mock backs demo mode and tests; the NEAR implementation talks to the arena, router and DEX.

import { Near } from "near-kit";
import { pow10, toBigInt, USDC_DECIMALS } from "../amounts";
import { MOCK_TOKENS } from "../arena/mock";
import type { ArenaApi } from "../arena/types";
import type { DepositTx } from "./transaction";

export interface FundingSplit {
  fromCredit: bigint;
  fromWallet: bigint;
}

export interface RouterInfo {
  router: string | null;
  dex: string | null;
}

export interface TerminalChain {
  readonly mode: "mock" | "near";
  readonly arenaId: string;
  /** `preview_funding`: how a deposit of `totalUnits` splits between credit and wallet. */
  previewFunding(accountId: string, totalUnits: bigint): Promise<FundingSplit>;
  /**
   * USDC held in the NEAR wallet (`ft_balance_of` on the USDC token). Deposits through `ft_transfer_call`
   * spend wallet USDC, so this is the right source. The arena's internal liquid balance is a separate
   * payout bucket that must be withdrawn first; it is deliberately not counted here.
   */
  usdcBalance(accountId: string): Promise<bigint>;
  /** Expected token output (coin base units) for swapping `usdcIn`; null when no route or rate exists. */
  quoteTokenOut(tokenId: string, usdcIn: bigint): Promise<bigint | null>;
  getRouter(): Promise<RouterInfo>;
}

export type SendVia = "wallet" | "session";

/** Submits transactions. A real sender must show the wallet prompt; it never signs anything the caller did not pass. */
export interface TxSender {
  /** Resolves with how it was approved: a wallet prompt or a session key. */
  send(tx: DepositTx, signerId: string): Promise<SendVia>;
}

// ---- mock ----

export interface MockChainOptions {
  /** Starting wallet USDC (base units) for any account. Default 100 USDC. */
  walletUsdc?: bigint;
  now?: () => number;
}

export interface MockTerminalChain extends TerminalChain, TxSender {
  readonly sent: DepositTx[];
  /** Simulate USDC arriving in a wallet (e.g. from a bridge). */
  credit(accountId: string, units: bigint): void;
  /** Make the next `send` fail. */
  failNextSend(message: string): void;
}

export function createMockTerminalChain(api: ArenaApi, opts: MockChainOptions = {}): MockTerminalChain {
  const now = opts.now ?? Date.now;
  const start = opts.walletUsdc ?? 100_000_000n;
  const wallets = new Map<string, bigint>();
  const creditSpent = new Map<string, bigint>();
  const sent: DepositTx[] = [];
  let failure: string | null = null;
  const wallet = (id: string) => wallets.get(id) ?? start;

  const availableCredit = async (id: string): Promise<bigint> => {
    const acc = await api.getAccount(id);
    const expiresMs = Number(toBigInt(acc.credit_expires_at_ns) / 1_000_000n);
    if (expiresMs <= now()) return 0n;
    const left = toBigInt(acc.credit_balance) - (creditSpent.get(id) ?? 0n);
    return left > 0n ? left : 0n;
  };

  const chain: MockTerminalChain = {
    mode: "mock",
    arenaId: "arena.testnet",
    sent,
    async previewFunding(id, total) {
      const credit = await availableCredit(id);
      const fromCredit = credit < total ? credit : total;
      return { fromCredit, fromWallet: total - fromCredit };
    },
    async usdcBalance(id) {
      return wallet(id);
    },
    async quoteTokenOut(tokenId, usdcIn) {
      const t = MOCK_TOKENS[tokenId];
      if (!t) return null;
      // coin = usdc / price, with the price scaled by 1e18.
      return (usdcIn * pow10(t.decimals) * pow10(18)) / (t.price * pow10(USDC_DECIMALS));
    },
    async getRouter() {
      return { router: "router.testnet", dex: "dex.testnet" };
    },
    credit(id, units) {
      wallets.set(id, wallet(id) + units);
    },
    failNextSend(message) {
      failure = message;
    },
    async send(tx, signerId) {
      if (failure) {
        const m = failure;
        failure = null;
        throw new Error(m);
      }
      const msg =
        tx.method === "ft_transfer_call"
          ? (JSON.parse(tx.args.msg) as { battle_id: number; side: "A" | "B"; total_usdc: string; min_token_out: string })
          : tx.args;
      const amount = tx.method === "ft_transfer_call" ? BigInt(tx.args.amount) : 0n;
      const total = BigInt(msg.total_usdc);
      const split = await chain.previewFunding(signerId, total);
      if (amount < split.fromWallet) throw new Error("Arena rejected the deposit: amount below the wallet part");
      if (wallet(signerId) < amount) throw new Error("Not enough USDC in the wallet");
      const battle = await api.getBattle(msg.battle_id);
      if (!battle || battle.status !== "Approved") throw new Error("Arena rejected the deposit: battle is not open");
      const tokenId = msg.side === "A" ? battle.token_a : battle.token_b;
      const out = await chain.quoteTokenOut(tokenId, total);
      if (out === null || out < BigInt(msg.min_token_out)) throw new Error("Swap output below the minimum; deposit returned");
      wallets.set(signerId, wallet(signerId) - split.fromWallet);
      creditSpent.set(signerId, (creditSpent.get(signerId) ?? 0n) + split.fromCredit);
      await api.depositCoin({ signerId, battleId: msg.battle_id, side: msg.side, tokenId, amount: out });
      sent.push(tx);
      return "wallet";
    },
  };
  return chain;
}

// ---- NEAR ----

export interface NearChainOptions {
  arenaId: string;
  /** Resolved lazily (the arena config names the USDC contract). */
  getUsdcId: () => Promise<string>;
  network: "testnet" | "mainnet";
  rpcUrl: string;
}

export function createNearTerminalChain(opts: NearChainOptions): TerminalChain {
  const reader = new Near({ network: opts.network, rpcUrl: opts.rpcUrl });
  const view = async <T>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> => {
    const r = await reader.view<T>(contract, method, args);
    if (r === undefined) throw new Error(`${contract}.${method} returned no value`);
    return r;
  };
  // The arena names its router in `get_config`; the router names the DEX.
  const getRouter = async (): Promise<RouterInfo> => {
    const cfg = await view<{ router: string | null }>(opts.arenaId, "get_config");
    if (!cfg.router) return { router: null, dex: null };
    const rc = await view<{ dex: string | null }>(cfg.router, "get_config");
    return { router: cfg.router, dex: rc.dex ?? null };
  };
  return {
    mode: "near",
    arenaId: opts.arenaId,
    async previewFunding(accountId, totalUnits) {
      const r = await view<{ from_credit: string; from_wallet: string }>(opts.arenaId, "preview_funding", {
        account_id: accountId,
        total_usdc: totalUnits.toString(),
      });
      return { fromCredit: BigInt(r.from_credit), fromWallet: BigInt(r.from_wallet) };
    },
    async usdcBalance(accountId) {
      return BigInt(await view<string>(await opts.getUsdcId(), "ft_balance_of", { account_id: accountId }));
    },
    async quoteTokenOut(tokenId, usdcIn) {
      const { dex } = await getRouter();
      if (!dex) return null;
      // The DEX exposes its fixed rate as `get_rate`: out = in * num / den.
      const rate = await view<{ num: string; den: string } | null>(dex, "get_rate", { token_in: await opts.getUsdcId(), token_out: tokenId });
      if (!rate || BigInt(rate.den) === 0n) return null;
      return (usdcIn * BigInt(rate.num)) / BigInt(rate.den);
    },
    getRouter,
  };
}
