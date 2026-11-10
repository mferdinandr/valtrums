"use client";

import { useEffect, useRef, useState } from "react";

export type PriceSample = { t: number; price: number };
export type ReferenceState = {
  state: "loading" | "live" | "unavailable";
  series: Record<string, PriceSample[]>;
  error: string | null;
};

const MAX_SAMPLES = 120;

/**
 * Polls the display-only reference price route once per second while `enabled` and keeps the last two minutes per
 * symbol. A failed read keeps the samples already drawn and marks the preview unavailable; it never fills a gap.
 */
export function useReferencePrices(enabled: boolean): ReferenceState {
  const [view, setView] = useState<ReferenceState>({
    state: "loading",
    series: {},
    error: null,
  });
  const store = useRef<Record<string, PriceSample[]>>({});

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const res = await fetch("/api/reference-price", { cache: "no-store" });
        const body = (await res.json()) as {
          ok?: boolean;
          ts?: number;
          prices?: Record<string, number | null>;
          error?: string;
        };
        if (stopped) return;
        if (
          !res.ok ||
          body.ok !== true ||
          !body.prices ||
          typeof body.ts !== "number"
        ) {
          setView((v) => ({
            ...v,
            state: "unavailable",
            error: body.error ?? `HTTP ${res.status}`,
          }));
          return;
        }
        for (const [symbol, price] of Object.entries(body.prices)) {
          if (price === null || !Number.isFinite(price)) continue;
          const list = store.current[symbol] ?? [];
          if (list.at(-1)?.t === body.ts) continue;
          store.current[symbol] = [...list, { t: body.ts, price }].slice(
            -MAX_SAMPLES,
          );
        }
        setView({ state: "live", series: { ...store.current }, error: null });
      } catch (error) {
        if (!stopped)
          setView((v) => ({
            ...v,
            state: "unavailable",
            error: error instanceof Error ? error.message : "request failed",
          }));
      } finally {
        busy = false;
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 1_000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [enabled]);

  return view;
}
