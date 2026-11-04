// Validation: resolve a parsed intent against on-chain data into an executable plan, a clarifying question,
// or a blocked result. Nothing executes unless the result is `ready`.

import { BPS, formatUsdc, msUntilNs, toBigInt } from "../amounts";
import type { ArenaApi, BattleView, Side } from "../arena/types";
import type { TerminalChain } from "./chain";
import { usdcUnits, type ParsedIntent } from "./intent";

export interface BridgeLeg {
  chain: string;
  /** USDC base units to bring in from that chain. */
  amount: bigint;
}

export interface DepositPlan {
  accountId: string;
  battleId: number;
  side: Side;
  tokenId: string;
  tokenSymbol: string;
  tokenDecimals: number;
  arenaId: string;
  usdcId: string;
  /** Total USDC value of the deposit. */
  totalUnits: bigint;
  /** Credit the arena will consume (credit is always used first). */
  creditUnits: bigint;
  /** USDC sent by `ft_transfer_call`: `total - credit`. */
  walletUnits: bigint;
  /** Part of the wallet amount that is already in the NEAR wallet. */
  nearWalletUnits: bigint;
  /** Part of the wallet amount that must be bridged in first. */
  bridgeLegs: BridgeLeg[];
  expectedOut: bigint;
  minOut: bigint;
  slippageBps: number;
  battleLabel: string;
  /** Non-blocking remarks shown in the summary. */
  notes: string[];
}

export type Resolution =
  | { kind: "clarify"; question: string }
  | { kind: "blocked"; reasons: string[] }
  | { kind: "ready"; plan: DepositPlan };

export interface ResolveContext {
  api: ArenaApi;
  chain: TerminalChain;
  accountId: string;
  nowMs: number;
}

interface Candidate {
  battle: BattleView;
  side: Side;
  tokenId: string;
  symbol: string;
  decimals: number;
}

async function loadBattles(api: ArenaApi): Promise<BattleView[]> {
  const count = await api.getBattleCount();
  const out: BattleView[] = [];
  for (let from = 0; from < count && out.length < 500; from += 100) out.push(...(await api.getBattles(from, 100)));
  return out;
}

/** Why a battle cannot take deposits right now, or null when it can. */
export function depositBlocker(b: BattleView, nowMs: number): string | null {
  if (b.status !== "Approved") return `Battle #${b.id} is ${b.status}, deposits are only open while it is Approved.`;
  if (msUntilNs(toBigInt(b.deposit_deadline_ns), nowMs) <= 0) return `The deposit window of battle #${b.id} has closed.`;
  return null;
}

export async function resolveIntent(intent: ParsedIntent, ctx: ResolveContext): Promise<Resolution> {
  const { api, chain, accountId, nowMs } = ctx;
  const battles = await loadBattles(api);

  const pool = intent.battle !== undefined ? battles.filter((b) => b.id === intent.battle) : battles;
  if (intent.battle !== undefined && pool.length === 0) return { kind: "blocked", reasons: [`Battle #${intent.battle} does not exist.`] };

  const wanted = intent.token?.toUpperCase();
  const candidates: Candidate[] = [];
  for (const b of pool) {
    for (const side of ["A", "B"] as const) {
      if (intent.side && intent.side !== side) continue;
      const tokenId = side === "A" ? b.token_a : b.token_b;
      const meta = await api.getTokenMeta(tokenId);
      if (wanted && meta.symbol.toUpperCase() !== wanted && tokenId.toUpperCase() !== wanted) continue;
      candidates.push({ battle: b, side, tokenId, symbol: meta.symbol, decimals: meta.decimals });
    }
  }
  if (candidates.length === 0) {
    const what = [intent.token ? `$${intent.token}` : null, intent.side ? `tribe ${intent.side}` : null, intent.battle ? `battle #${intent.battle}` : null]
      .filter(Boolean)
      .join(", ");
    return { kind: "blocked", reasons: [`Nothing matches ${what || "that request"}.`] };
  }

  const open = candidates.filter((c) => depositBlocker(c.battle, nowMs) === null);
  if (open.length === 0) {
    return { kind: "blocked", reasons: [...new Set(candidates.map((c) => depositBlocker(c.battle, nowMs)!))] };
  }
  if (open.length > 1) {
    const list = open.map((c) => `battle #${c.battle.id} tribe ${c.side} ($${c.symbol})`).join("; ");
    return { kind: "clarify", question: `That matches more than one side: ${list}. Which one?` };
  }
  const pick = open[0]!;
  const reasons: string[] = [];

  const total = usdcUnits(intent.totalUsdc);
  if (total === null || total <= 0n) return { kind: "blocked", reasons: ["The amount is not a valid USDC value."] };

  const [cfg, router, account, position] = await Promise.all([
    api.getConfig(),
    chain.getRouter(),
    api.getAccount(accountId),
    api.getPosition(pick.battle.id, accountId),
  ]);
  if (!router.router || !router.dex) reasons.push("USDC deposits are not available: the swap router is not configured.");
  if (position && position.side !== pick.side) {
    reasons.push(`You already back tribe ${position.side} in battle #${pick.battle.id}. A wallet can only back one tribe.`);
  }

  // Credit the prompt claims versus credit that really exists (and has not expired).
  const claimedCredit = intent.sources.filter((s) => s.kind === "credit").reduce((a, s) => a + (usdcUnits(s.amount) ?? 0n), 0n);
  const creditAlive = msUntilNs(toBigInt(account.credit_expires_at_ns), nowMs) > 0;
  const availableCredit = creditAlive ? toBigInt(account.credit_balance) : 0n;
  if (claimedCredit > availableCredit) {
    reasons.push(
      `You asked to use ${formatUsdc(claimedCredit)} of credit but only ${formatUsdc(availableCredit)} is available${
        availableCredit === 0n && toBigInt(account.credit_balance) > 0n ? " (your credit has expired)" : ""
      }.`,
    );
  }

  const preview = await chain.previewFunding(accountId, total);
  const notes: string[] = [];
  if (claimedCredit < preview.fromCredit) {
    notes.push(`Credit is always used first: ${formatUsdc(preview.fromCredit)} of credit will be used, not ${formatUsdc(claimedCredit)}.`);
  }

  // Wallet part: bridged USDC first (as requested), the rest from the NEAR wallet.
  let bridgeLeft = preview.fromWallet;
  const bridgeLegs: BridgeLeg[] = [];
  for (const s of intent.sources.filter((x) => x.kind === "other_chain")) {
    const want = usdcUnits(s.amount) ?? 0n;
    const take = want < bridgeLeft ? want : bridgeLeft;
    if (take < want) notes.push(`Credit covers more than planned, so the ${s.chain} transfer is reduced to ${formatUsdc(take)}.`);
    if (take > 0n) bridgeLegs.push({ chain: s.chain!, amount: take });
    bridgeLeft -= take;
  }
  const nearWalletUnits = bridgeLeft;
  if (nearWalletUnits > 0n) {
    const balance = await chain.usdcBalance(accountId);
    if (balance < nearWalletUnits) {
      reasons.push(`Your NEAR wallet holds ${formatUsdc(balance)} USDC but ${formatUsdc(nearWalletUnits)} is needed.`);
    }
  }

  const expectedOut = await chain.quoteTokenOut(pick.tokenId, total);
  if (expectedOut === null || expectedOut <= 0n) {
    reasons.push(`No swap quote is available for ${pick.symbol}, so a safe minimum output cannot be set.`);
  }

  if (reasons.length > 0 || expectedOut === null) return { kind: "blocked", reasons };

  const minOut = (expectedOut * (BPS - BigInt(intent.slippageBps))) / BPS;
  return {
    kind: "ready",
    plan: {
      accountId,
      battleId: pick.battle.id,
      side: pick.side,
      tokenId: pick.tokenId,
      tokenSymbol: pick.symbol,
      tokenDecimals: pick.decimals,
      arenaId: chain.arenaId,
      usdcId: cfg.usdc,
      totalUnits: total,
      creditUnits: preview.fromCredit,
      walletUnits: preview.fromWallet,
      nearWalletUnits,
      bridgeLegs,
      expectedOut,
      minOut,
      slippageBps: intent.slippageBps,
      battleLabel: `#${pick.battle.id}`,
      notes,
    },
  };
}
