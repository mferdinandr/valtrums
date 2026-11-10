import { performanceBps, toBigInt } from "@/lib/amounts";
import { priceBasis } from "@/lib/arena/payout";
import type { BattleView, LivePrices, TokenMeta } from "@/lib/arena/types";
import type { ChartSeries } from "./model";

/** The legacy API exposes snapshots, not observation history. Do not join the dots. */
export function snapshotSeries(
  battle: BattleView,
  metas: [TokenMeta, TokenMeta],
  live: LivePrices | null,
): ChartSeries[] {
  const basis = priceBasis(battle, live);
  return metas.map((meta, index) => {
    const initial = toBigInt(
      index === 0 ? battle.initial_price_a : battle.initial_price_b,
    );
    const current = basis ? (index === 0 ? basis.a : basis.b) : null;
    const bps =
      current && current > 0n
        ? performanceBps(initial > 0n ? initial : null, current)
        : null;
    const points = initial > 0n ? [{ x: 0, value: 0 }] : [];
    if (bps !== null && basis?.source !== "initial")
      points.push({ x: 1, value: Number(bps) / 100 });
    return {
      id: index === 0 ? "A" : "B",
      name: meta.symbol,
      color: index === 0 ? "#327f7d" : "#ad5273",
      points,
    };
  });
}
