import { toBigInt, USDC_DECIMALS } from "../amounts";
import type { ArenaApi, BattleView, TokenMeta } from "./types";

/** Tokens whose liquid balance is worth showing: USDC first, then the coins of the given battles. */
export function liquidTokenIds(usdc: string, battles: readonly Pick<BattleView, "token_a" | "token_b">[]): string[] {
  const ids = [usdc];
  for (const b of battles) {
    for (const t of [b.token_a, b.token_b]) if (!ids.includes(t)) ids.push(t);
  }
  return ids;
}

/** USDC always has 6 decimals; every other token uses its own metadata. */
export function metaFor(tokenId: string, usdc: string, metas: Record<string, TokenMeta>, fallback: (id: string) => TokenMeta): TokenMeta {
  if (tokenId === usdc) return { id: tokenId, symbol: "USDC", decimals: USDC_DECIMALS };
  return metas[tokenId] ?? fallback(tokenId);
}

export async function readLiquidBalances(api: ArenaApi, accountId: string, tokenIds: readonly string[]): Promise<Record<string, bigint>> {
  const entries = await Promise.all(
    tokenIds.map(async (t) => [t, toBigInt(await api.getLiquidBalance(accountId, t))] as const),
  );
  return Object.fromEntries(entries);
}

export class WithdrawNotCompletedError extends Error {
  constructor() {
    super("The token transfer did not go through. Your liquid balance was restored; try again.");
    this.name = "WithdrawNotCompletedError";
  }
}

/**
 * Calls `withdraw_liquid` and confirms the balance actually went down. The contract debits first and
 * restores the balance when the token transfer fails, which a successful transaction does not reveal.
 * Returns the remaining balance.
 */
export async function withdrawLiquidChecked(
  api: ArenaApi,
  input: { signerId: string; token: string; amount: bigint },
): Promise<bigint> {
  const before = toBigInt(await api.getLiquidBalance(input.signerId, input.token));
  await api.withdrawLiquid(input);
  const after = toBigInt(await api.getLiquidBalance(input.signerId, input.token));
  if (after >= before) throw new WithdrawNotCompletedError();
  return after;
}
