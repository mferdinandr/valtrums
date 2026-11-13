"use client";

import { useState } from "react";

export function DrawdownCalculator() {
  const [text, setText] = useState("100, 120, 90, 110");
  const prices = text
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  let peak = 0;
  let worst = 0;
  let from: number | null = null;
  let to: number | null = null;
  let peakAt = 0;
  prices.forEach((p, i) => {
    if (p > peak) {
      peak = p;
      peakAt = i;
    }
    const dd = (peak - p) / peak;
    if (dd > worst) {
      worst = dd;
      from = peakAt;
      to = i;
    }
  });
  const valid = prices.length >= 2;
  const max = valid ? Math.max(...prices) : 1;
  const min = valid ? Math.min(...prices) : 0;
  const span = max - min || 1;
  const pts = prices
    .map((p, i) => `${10 + (i * 280) / Math.max(prices.length - 1, 1)},${90 - ((p - min) / span) * 70}`)
    .join(" ");
  return (
    <div className="widget">
      <label className="widget-field">
        Prices during the round, separated by commas
        <input value={text} onChange={(e) => setText(e.target.value)} className="widget-input" />
      </label>
      {valid ? (
        <>
          <svg viewBox="0 0 300 100" className="widget-chart" role="img" aria-label="Price path during the round">
            <polyline points={pts} fill="none" stroke="#36775c" strokeWidth="2.5" strokeLinejoin="round" />
          </svg>
          <div className="widget-result" aria-live="polite">
            Maximum drawdown: <strong>{(worst * 100).toFixed(2)}%</strong>
            {from !== null && to !== null
              ? ` (from ${prices[from]} down to ${prices[to]})`
              : " (the price never fell)"}
          </div>
        </>
      ) : (
        <div className="widget-hint">Enter at least two positive prices.</div>
      )}
    </div>
  );
}
