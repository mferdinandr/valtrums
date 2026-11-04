import { coinToUsdc, payoutPreview, profitShare, toBigInt, type PayoutPreview } from "../amounts";
import type { BattleView, LivePrices, PositionView, TokenMeta } from "./types";

export interface PriceBasis {
  a: bigint;
  b: bigint;
  source: "final" | "live" | "initial";
}

/** Pick the best available prices: final, then live, then initial. */
export function priceBasis(battle: BattleView, live: LivePrices | null): PriceBasis | null {
  if (battle.final_price_a && battle.final_price_b) {
    return { a: BigInt(battle.final_price_a), b: BigInt(battle.final_price_b), source: "final" };
  }
  if (live) return { ...live, source: "live" };
  if (battle.initial_price_a && battle.initial_price_b) {
    return { a: BigInt(battle.initial_price_a), b: BigInt(battle.initial_price_b), source: "initial" };
  }
  return null;
}

/** Both vaults valued in USDC base units. */
export function vaultsInUsdc(
  battle: BattleView,
  metaA: TokenMeta,
  metaB: TokenMeta,
  prices: PriceBasis,
): { a: bigint; b: bigint } {
  return {
    a: coinToUsdc(toBigInt(battle.vault_a), metaA.decimals, prices.a),
    b: coinToUsdc(toBigInt(battle.vault_b), metaB.decimals, prices.b),
  };
}

/**
 * Preview of what a position receives if its side wins. Principal is the position's USDC-equivalent
 * stake; profit is its pro-rata share of the losing vault.
 */
export function previewWinnerPayout(
  position: PositionView,
  vaults: { a: bigint; b: bigint },
): PayoutPreview {
  const winnerVault = position.side === "A" ? vaults.a : vaults.b;
  const loserVault = position.side === "A" ? vaults.b : vaults.a;
  const principal = toBigInt(position.usdc_equiv);
  return payoutPreview(principal, profitShare(principal, winnerVault, loserVault));
}
