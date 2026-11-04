import { coinToUsdc, splitProfit, toBigInt, usdcToCoin } from "../amounts";
import type { BattleView, LivePrices, PositionView, SettlementStep, TokenMeta } from "./types";

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

export interface ClaimPreview {
  /** The position's own coins, credited back to the liquid balance (winner coin units). */
  principalCoin: bigint;
  /** Liquid reward in the winner coin: the position's share of the coins bought for the liquid pool. */
  rewardCoin: bigint;
  /** principalCoin + rewardCoin: what `claim` adds to the liquid balance of the winner coin. */
  totalCoin: bigint;
  /** New locked USDC credit granted by `claim`. */
  credit: bigint;
  /** USDC value of the liquid reward, for display only. */
  rewardUsdc: bigint;
  /** The position's share of the burn and fee pools (USDC), for display only. */
  burn: bigint;
  fee: bigint;
  /** Dump proceeds the pools were computed from (USDC base units). */
  dumpProceeds: bigint;
  /** True while the numbers rest on prices instead of reported plan steps. */
  estimated: boolean;
}

function reportedRealized(plan: SettlementStep[] | null, kind: SettlementStep["kind"]): bigint | null {
  const step = plan?.find((s) => s.kind === kind);
  return step && step.done && step.realized !== null ? BigInt(step.realized) : null;
}

/**
 * What a position receives if its side wins. The contract shares every pool pro-rata by the position's
 * share of the winner vault (coin units). Pools come from the dump proceeds: 55% buys the winner coin
 * (liquid reward), 35% becomes locked credit, 5% is burned, 5% is the protocol fee. Reported plan steps
 * replace the price-based estimate as they land.
 */
export function previewClaim(input: {
  position: PositionView;
  winnerVaultCoin: bigint;
  winnerDecimals: number;
  winnerPrice: bigint;
  /** Loser vault valued in USDC; used until the dump is reported. */
  loserVaultUsdc: bigint;
  plan: SettlementStep[] | null;
}): ClaimPreview {
  const { position, winnerVaultCoin, winnerDecimals, winnerPrice, loserVaultUsdc, plan } = input;
  const dumpReported = reportedRealized(plan, "Dump");
  const dumpProceeds = dumpReported ?? loserVaultUsdc;
  const pool = splitProfit(dumpProceeds);
  const boughtCoin = reportedRealized(plan, "Buy") ?? usdcToCoin(pool.liquid, winnerDecimals, winnerPrice);

  const principalCoin = toBigInt(position.coin_amount);
  const part = (pot: bigint): bigint => (winnerVaultCoin > 0n ? (pot * principalCoin) / winnerVaultCoin : 0n);
  const rewardCoin = part(boughtCoin);
  return {
    principalCoin,
    rewardCoin,
    totalCoin: principalCoin + rewardCoin,
    credit: part(pool.credit),
    rewardUsdc: coinToUsdc(rewardCoin, winnerDecimals, winnerPrice),
    burn: part(pool.burn),
    fee: part(pool.fee),
    dumpProceeds,
    estimated: dumpReported === null,
  };
}

/** previewClaim for a position of `battle`, assuming the position's own side wins. */
export function previewClaimForBattle(
  battle: BattleView,
  position: PositionView,
  metaA: TokenMeta,
  metaB: TokenMeta,
  prices: PriceBasis,
  plan: SettlementStep[] | null,
): ClaimPreview {
  const vaults = vaultsInUsdc(battle, metaA, metaB, prices);
  const a = position.side === "A";
  return previewClaim({
    position,
    winnerVaultCoin: toBigInt(a ? battle.vault_a : battle.vault_b),
    winnerDecimals: (a ? metaA : metaB).decimals,
    winnerPrice: a ? prices.a : prices.b,
    loserVaultUsdc: a ? vaults.b : vaults.a,
    plan,
  });
}
