"use client";

import { useMemo, useState } from "react";
import { useReferencePrices } from "@/hooks/use-reference-prices";
import { percentFrom } from "@/lib/reference-price/math";
import { referencePool } from "@/lib/reference-price/pools";
import { accentFor } from "@/lib/arena-read/token-style";
import { ScoreChart } from "./chart";
import type { ChartSeries } from "./model";

/**
 * Live preview of the competing tokens' reference prices, drawn as percent change since the page opened. It is a
 * reference price read from a mainnet pool once per second, NOT scoring evidence: the contract scores only the
 * oracle's recorded observations, and this chart never picks or implies a winner.
 */
export function ReferencePreviewChart({ symbols }: { symbols: string[] }) {
  const view = useReferencePrices(true);
  const [selected, setSelected] = useState(symbols[0] ?? "");
  const unique = useMemo(
    () => Array.from(new Set(symbols.map((s) => s.toUpperCase()))),
    [symbols],
  );
  const missing = unique.filter((s) => !referencePool(s));

  const { series, duration } = useMemo(() => {
    const out: ChartSeries[] = [];
    let max = 30;
    for (const symbol of unique) {
      const samples = view.series[symbol];
      if (!samples?.length) continue;
      const t0 = samples[0]!.t;
      const first = samples[0]!.price;
      const points = samples.map((s) => ({
        x: (s.t - t0) / 1000,
        value: percentFrom(first, s.price),
      }));
      max = Math.max(max, points.at(-1)?.x ?? 0);
      out.push({ id: symbol, name: symbol, color: accentFor(symbol), points });
    }
    return { series: out, duration: max };
  }, [unique, view.series]);

  if (view.state === "loading") {
    return (
      <p role="status" className="text-xs text-mute">
        Reading reference prices…
      </p>
    );
  }
  if (series.length === 0) {
    return (
      <p role="alert" className="text-xs text-neon-red">
        Reference prices unavailable{view.error ? `: ${view.error}` : ""}.
        Nothing is drawn in its place.
      </p>
    );
  }
  return (
    <section className="space-y-2" aria-label="Live reference price preview">
      <ScoreChart
        title="Live reference prices (preview)"
        source="Uniswap v3 pools on Robinhood Chain mainnet · read once per second · percent change since this page opened"
        status={
          view.state === "unavailable"
            ? `Stale · ${view.error ?? "refresh failed"}`
            : "Live"
        }
        note="Preview only. This is a market reference price, not scoring evidence. The arena scores a round from the oracle's recorded observations after the crews lock in, and this chart never decides a winner."
        series={series}
        selected={selected}
        onSelect={setSelected}
        duration={duration}
        pending
        hideLead
        resetKey="reference-preview"
      />
      {missing.length > 0 && (
        <p className="text-xs text-mute">
          No reference pool for {missing.join(", ")}; it is not drawn.
        </p>
      )}
    </section>
  );
}
