"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Expand, X, TrendingUp } from "lucide-react";
import { chartSegments, displayStandings, relativeToField, type ChartPoint, type ChartSeries } from "./model";
import "./chart.css";
import { TokenIcon } from "@/components/token-icon";

/** Length in px of one colour stripe where several series coincide. */
const STRIPE = 7;

interface Geometry {
  min: number;
  max: number;
  heads: Map<string, { x: number; v: number }>;
}

/**
 * Eases the axis range and each series' newest point toward their targets every animation frame
 * using elapsed time so updates feel consistent at different frame rates. Reduced-motion users get
 * the targets at once; the animation stops when there is no new sample.
 */
function useSmoothedGeometry(
  targetMin: number,
  targetMax: number,
  targetHeads: Map<string, { x: number; v: number; segmentStart: number }>,
): Geometry {
  const [, frame] = useState(0);
  const current = useRef<Geometry | null>(null);
  const target = useRef({ min: targetMin, max: targetMax, heads: targetHeads });
  target.current = { min: targetMin, max: targetMax, heads: targetHeads };
  if (!current.current) {
    current.current = {
      min: targetMin,
      max: targetMax,
      heads: new Map([...targetHeads].map(([id, h]) => [id, { x: h.x, v: h.v }])),
    };
  }
  const key = `${targetMin}|${targetMax}|${[...targetHeads].map(([id, h]) => `${id}:${h.x}:${h.v}`).join(",")}`;
  useEffect(() => {
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let previousFrame: number | undefined;
    const step = (now: number) => {
      const t = target.current;
      const c = current.current!;
      const elapsed = previousFrame === undefined ? 16 : Math.min(now - previousFrame, 100);
      previousFrame = now;
      // A longer follow-through carries the motion between typical one-second updates without
      // extrapolating beyond the newest observed point. Missing updates still settle and stop.
      const k = reduce ? 1 : 1 - Math.exp(-elapsed / 230);
      let moving = false;
      const ease = (from: number, to: number, scale: number) => {
        const d = to - from;
        if (Math.abs(d) <= Math.max(scale, Number.EPSILON * Math.abs(to), Number.MIN_VALUE) * 0.0001) return to;
        moving = true;
        return from + d * k;
      };
      const scale = Math.max(t.max - t.min, Number.MIN_VALUE);
      c.min = ease(c.min, t.min, scale);
      c.max = ease(c.max, t.max, scale);
      for (const id of [...c.heads.keys()]) if (!t.heads.has(id)) c.heads.delete(id);
      for (const [id, h] of t.heads) {
        const shown = c.heads.get(id);
        if (!shown || shown.x < h.segmentStart) {
          c.heads.set(id, { x: h.x, v: h.v });
          continue;
        }
        shown.x = ease(shown.x, h.x, 30);
        shown.v = ease(shown.v, h.v, scale);
      }
      frame((n) => n + 1);
      if (moving) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [key]);
  return current.current;
}

interface Props {
  title: string;
  source: string;
  note: string;
  series: ChartSeries[];
  selected: string;
  onSelect: (id: string) => void;
  duration: number;
  lowerIsBetter?: boolean;
  connected?: boolean;
  status?: string;
  result?: string;
  pending?: boolean;
  /** Hide the status line under the source (used by the display-only price preview, which assigns no result). */
  hideLead?: boolean;
  range?: [number, number];
  signed?: boolean;
  resetKey?: string | number;
  closingTimes?: number[];
  ranks?: { community: number; rank: number }[];
}
const score = (value: number, signed = true, digits = 2) =>
  `${signed && value > 0 ? "+" : ""}${value.toFixed(digits)}%`;

/**
 * Decimals needed for the given scores to read as different numbers (2 to 12). Scores that are still equal at
 * 12 decimals stay equal: a real tie is shown as a tie, never stretched into a fake difference.
 */
export const MAX_SCORE_DIGITS = 16;
/** Scores closer than this (in percentage points) are rounding noise, not a real difference. */
export const NOISE_SPREAD = 1e-6;
export function scoreDigits(values: readonly number[]): number {
  const distinct = new Set(values.map((v) => v.toFixed(MAX_SCORE_DIGITS))).size;
  for (let d = 2; d <= MAX_SCORE_DIGITS; d++) {
    if (new Set(values.map((v) => v.toFixed(d))).size >= distinct) return d;
  }
  return MAX_SCORE_DIGITS;
}

/** A gap between two scores with enough digits to be visible, or "<0.000000000001" below the precision. */
export function gapText(gap: number): string {
  if (gap === 0) return "0";
  if (gap < 1e-16) return "<0.0000000000000001";
  return gap.toFixed(scoreDigits([0, gap]));
}

function Plot({
  series: allSeries,
  selected,
  onSelect,
  duration,
  connected = true,
  range,
  signed = true,
  deviation = false,
  legendSeries,
  result,
  closingTimes,
  ranks,
}: {
  series: ChartSeries[];
  selected: string;
  onSelect: (id: string) => void;
  duration: number;
  connected?: boolean;
  range?: [number, number];
  signed?: boolean;
  /** `series` holds each token's distance from the average, so the axis may zoom down to 1e-16. */
  deviation?: boolean;
  /** The real scores shown in the legend when `series` is a derived view. */
  legendSeries?: ChartSeries[];
  result?: string;
  closingTimes?: number[];
  ranks?: { community: number; rank: number }[];
}) {
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600),
    [sample, setSample] = useState<number | null>(null);
  useEffect(() => { if (result) setSample(null); }, [result]);
  const start = 0, end = duration;
  // A symmetric logarithmic scale keeps tiny gaps legible across the whole round while compressing spikes.
  const magnitudes = allSeries.flatMap((s) => s.points.flatMap((p) => p.value !== null && Number.isFinite(p.value) && p.value !== 0 ? [Math.abs(p.value)] : [])).sort((a, b) => a - b);
  const linearScale = magnitudes[Math.floor(magnitudes.length / 2)] ?? 1;
  const transform = (v: number) => deviation ? Math.asinh(v / linearScale) : v;
  const inverse = (v: number) => deviation ? Math.sinh(v) * linearScale : v;
  const series = deviation ? allSeries.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, value: p.value === null ? null : transform(p.value) })) })) : allSeries;
  const description = useId();
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setWidth(Math.max(280, rect.width));
    });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const points = series
    .flatMap((s) => s.points)
    .filter((p) => p.value !== null && Number.isFinite(p.value));
  const values = points.map((p) => p.value!);
  // Fit the axis to how far the lines actually move, not to zero: a small move fills the chart height, so
  // it reads as movement. The floor keeps rounding noise (far below 0.000002%) drawn as a flat line, and the
  // axis labels always state the real scale.
  const hasValues = values.length > 0;
  const dataLow = hasValues ? Math.min(...values) : 0,
    dataHigh = hasValues ? Math.max(...values) : 0,
    fitSpan = Math.max(dataHigh - dataLow, deviation ? 0.1 : 0.000002),
    mid = (dataHigh + dataLow) / 2,
    pad = fitSpan * 0.15;
  const targetMin = range?.[0] ?? mid - fitSpan / 2 - pad,
    targetMax = range?.[1] ?? mid + fitSpan / 2 + pad;
  // Presentation only: the axis and the newest point glide to their true values. No value is invented;
  // when the motion ends every drawn point sits exactly on its recorded sample.
  const heads = new Map<string, { point: ChartPoint; x: number; v: number; segmentStart: number }>();
  for (const s of series) {
    const segments = chartSegments(s.points);
    const lastSegment = segments.at(-1);
    for (let i = s.points.length - 1; i >= 0; i--) {
      const p = s.points[i]!;
      if (p.value !== null && Number.isFinite(p.value)) {
        heads.set(s.id, { point: p, x: p.x, v: p.value, segmentStart: lastSegment?.[0]?.x ?? p.x });
        break;
      }
    }
  }
  const smooth = useSmoothedGeometry(targetMin, targetMax, heads);
  // Series with exactly the same points lie on top of each other. They are drawn as interleaved
  // stripes so every colour stays visible, and named in a note below the chart.
  const fingerprint = (s: ChartSeries) =>
    s.points.length === 0
      ? null
      : s.points.map((p) => (p.value === null ? `gap:${p.x}` : `${p.x}:${p.value}`)).join("|");
  const sameLine = new Map<string, ChartSeries[]>();
  for (const s of series) {
    const f = fingerprint(s);
    if (f !== null) sameLine.set(f, [...(sameLine.get(f) ?? []), s]);
  }
  const stripes = new Map<string, { index: number; size: number }>();
  const overlapping: ChartSeries[][] = [];
  for (const group of sameLine.values()) {
    if (group.length < 2) continue;
    overlapping.push(group);
    group.forEach((s, index) => stripes.set(s.id, { index, size: group.length }));
  }
  const min = smooth.min,
    max = smooth.max,
    span = max - min,
    // Enough decimals that neighbouring gridlines never print the same number.
    decimals = span > 0 && Number.isFinite(span) ? Math.min(16, Math.max(1, Math.ceil(-Math.log10(span)) + 2)) : 2,
    height = 260,
    left = 88,
    right = 22,
    top = 16,
    bottom = 30;
  const x = (t: number) =>
    left + ((t - start) / Math.max(1, end - start)) * (width - left - right);
  const y = (v: number) =>
    top + ((max - v) / (max - min)) * (height - top - bottom);
  const times = [
    ...new Set(series.flatMap((s) => s.points.map((p) => p.x))),
  ].sort((a, b) => a - b);
  const inspected =
    sample === null ? null : times[Math.min(sample, times.length - 1)];
  // Digits for the legend: as many as it takes for different scores to look different.
  const legendRows = legendSeries ?? series;
  const legendValues = legendRows.flatMap((s) => {
    const p = inspected === null ? s.points.findLast((q) => q.value !== null && Number.isFinite(q.value)) : s.points.find((q) => q.x === inspected);
    return p?.value !== null && p?.value !== undefined && Number.isFinite(p.value) ? [p.value] : [];
  });
  // Scores that differ only below NOISE_SPREAD are rounding noise: show them rounded (exact value in the tooltip)
  // instead of a 14-digit number that wraps and reads as a huge percentage.
  const level = legendValues.length > 1 && Math.max(...legendValues) !== Math.min(...legendValues) && Math.max(...legendValues) - Math.min(...legendValues) < NOISE_SPREAD;
  const legendDigits = level ? 4 : scoreDigits(legendValues);
  return (
    <div ref={root} className="score-chart-plot">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={description}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const time =
            ((((e.clientX - rect.left) / rect.width) * width - left) /
              (width - left - right)) *
            (end - start) + start;
          if (times.length)
            setSample(
              times.reduce(
                (best, t, i) =>
                  Math.abs(t - time) < Math.abs(times[best]! - time) ? i : best,
                0,
              ),
            );
        }}
        onPointerLeave={() => setSample(null)}
      >
        <title id={description}>
          {connected
            ? "Recorded score samples over this round"
            : "Available price-performance snapshots, with no interpolation"}
          . Select a community using the legend. Inspect exact samples with the
          slider below.
        </title>
        {[0, 0.5, 1].map((t) => {
          const value = min + (max - min) * t;
          return (
            <g key={t}>
              <line
                x1={left}
                x2={width - right}
                y1={y(value)}
                y2={y(value)}
                stroke="#d8ded8"
                strokeDasharray="3 5"
              />
              <text x={left - 8} y={y(value) + 4} textAnchor="end">
                {deviation ? `${inverse(value).toExponential(2)}%` : `${value.toFixed(decimals)}%`}
              </text>
            </g>
          );
        })}
        {min < 0 && max > 0 && (
          <line
            x1={left}
            x2={width - right}
            y1={y(0)}
            y2={y(0)}
            stroke="#aebbb3"
          />
        )}
        {[...new Set(closingTimes ?? [])].filter((t) => t >= start && t <= end).map((t) => (
          <g key={`close-${t}`}>
            <line x1={x(t)} x2={x(t)} y1={top} y2={height - bottom} stroke="#9b6d36" strokeDasharray="4 4" />
            <title>Estimated closing sample at {t.toFixed(1)}s</title>
          </g>
        ))}
        {[0, 0.5, 1].map((t) => (
          <text
            key={t}
            x={x(start + t * (end - start))}
            y={height - 6}
            textAnchor={t === 0 ? "start" : t === 1 ? "end" : "middle"}
          >
            {connected
              ? `${Math.round(start + t * (end - start))}s`
              : t === 0
                ? "Start"
                : t === 1
                  ? "Available snapshot"
                  : ""}
          </text>
        ))}
        {[...series]
          .map((s) => {
            const head = heads.get(s.id);
            const shown = smooth.heads.get(s.id);
            if (!head || !shown) return s;
            return { ...s, points: s.points.map((p) => (p === head.point ? { ...p, x: shown.x, value: shown.v } : p)) };
          })
          .sort((a, b) => Number(a.id === selected) - Number(b.id === selected))
          .map((s) => (
            <g
              key={s.id}
              opacity={s.id === selected ? 1 : s.inactive ? 0.28 : 0.65}
            >
              {connected &&
                chartSegments(s.points).map((segment, i) => (
                  <polyline
                    key={i}
                    points={segment
                      .map((p) => `${x(p.x)},${y(p.value!)}`)
                      .join(" ")}
                    fill="none"
                    onClick={() => onSelect(s.id)}
                    style={{ cursor: "pointer" }}
                    stroke={s.color}
                    strokeWidth={s.id === selected ? 3 : 1.8}
                    strokeLinecap={stripes.has(s.id) ? "butt" : "round"}
                    strokeLinejoin="round"
                    strokeDasharray={
                      stripes.has(s.id)
                        ? `${STRIPE} ${STRIPE * (stripes.get(s.id)!.size - 1)}`
                        : s.inactive
                          ? "4 4"
                          : undefined
                    }
                    strokeDashoffset={stripes.has(s.id) ? -STRIPE * stripes.get(s.id)!.index : undefined}
                  />
                ))}
              {connected &&
                s.points
                  .filter((p) => p.value !== null && Number.isFinite(p.value))
                  .slice(0, -1)
                  .map((p) => (
                    // One small dot per recorded sample, so the per-second cadence is visible on the line.
                    <circle key={`d${p.x}`} cx={x(p.x)} cy={y(p.value!)} r={1.7} fill={s.color} opacity={0.55} pointerEvents="none" />
                  ))}
              {s.points
                .filter((p) => p.value !== null && Number.isFinite(p.value))
                .filter((_, i, a) => !connected || i === a.length - 1)
                .map((p) => (
                  <circle
                    key={p.x}
                    cx={x(p.x)}
                    cy={y(p.value!)}
                    r={s.id === selected ? 4 : 3}
                    fill={s.color}
                    stroke="#fffaf0"
                    strokeWidth={1.5}
                    onClick={() => onSelect(s.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <title>
                      {s.name}: {deviation ? `${inverse(p.value!).toExponential(3)}% from field average` : score(p.value!, signed)}
                      {connected
                        ? ` at ${p.x.toFixed(1)}s`
                        : " · available snapshot"}
                    </title>
                  </circle>
                ))}
            </g>
          ))}
        {inspected !== null && inspected !== undefined && (
          <line
            x1={x(inspected)}
            x2={x(inspected)}
            y1={top}
            y2={height - bottom}
            stroke="#526777"
            strokeDasharray="3 4"
          />
        )}
        {!points.length && (
          <text x={width / 2} y={height / 2} textAnchor="middle">
            Waiting for score observations
          </text>
        )}
      </svg>
      {overlapping.map((group) => (
        <p key={group.map((s) => s.id).join()} className="score-chart-overlap">
          {group.map((s) => s.name).join(", ")} have identical results so far, so their lines lie on top of each
          other (shown as alternating stripes).
        </p>
      ))}
      {times.length > 1 && (
        <label className="score-chart-inspect">
          {connected ? "Inspect sample" : "Inspect snapshot"}
          <input
            type="range"
            aria-label={
              connected
                ? "Inspect recorded round sample"
                : "Inspect available snapshot"
            }
            min={0}
            max={times.length - 1}
            step={1}
            aria-valuetext={
              connected
                ? `${(times[sample ?? times.length - 1] ?? 0).toFixed(1)} seconds`
                : times[sample ?? times.length - 1] === 0
                  ? "Start snapshot"
                  : "Available snapshot"
            }
            value={sample ?? times.length - 1}
            onChange={(e) => setSample(Number(e.target.value))}
          />
          <span>
            {inspected === null || inspected === undefined
              ? result ? "Latest · result recorded" : "Latest"
              : connected
                ? `${inspected.toFixed(1)}s`
                : inspected === 0
                  ? "Start"
                  : "Available"}
          </span>
        </label>
      )}
      <div
        className="score-chart-legend"
        role="group"
        aria-label="Highlight a community; selection does not place a deposit"
      >
        {[...legendRows].sort((a, b) => inspected === null ? (ranks?.find((r) => String(r.community) === a.id)?.rank ?? Infinity) - (ranks?.find((r) => String(r.community) === b.id)?.rank ?? Infinity) : 0).map((s) => {
          const point =
            inspected === null
              ? s.points.findLast((p) => p.value !== null && Number.isFinite(p.value))
              : s.points.find((p) => p.x === inspected);
          return (
            <button
              key={s.id}
              aria-pressed={selected === s.id}
              onClick={() => onSelect(s.id)}
              style={{ "--line": s.color } as React.CSSProperties}
            >
              {inspected === null && ranks?.some((r) => String(r.community) === s.id) && <span className="score-chart-rank">{ranks.find((r) => String(r.community) === s.id)!.rank}</span>}
              <TokenIcon symbol={s.name} size={28} />
              <span className="score-chart-dot" />
              <span className="score-chart-token">
                {s.name}
                {s.inactive ? " · out" : ""}
              </span>
              <strong title={point?.value !== null && point?.value !== undefined ? `${point.value.toFixed(MAX_SCORE_DIGITS)}%` : undefined}>
                {point?.value !== null && point?.value !== undefined
                  ? score(point.value, signed, legendDigits)
                  : "—"}
              </strong>
            </button>
          );
        })}
      </div>
      {level && (
        <p className="mt-2 text-xs text-mute">
          Prices moved together: scores are level to 6 decimals. Differences below that are rounding noise.
        </p>
      )}
    </div>
  );
}

export function ScoreChart(props: Props) {
  const modal = useRef<HTMLDialogElement>(null),
    [expanded, setExpanded] = useState(false);
  // The companion strip exists only for a connected round chart of two or more tokens whose scores differ at all.
  const diffs = props.connected !== false && !props.range && props.series.length >= 2 ? relativeToField(props.series) : null;
  const diffValues = diffs?.flatMap((s) => s.points.flatMap((p) => (p.value !== null && Number.isFinite(p.value) ? [p.value] : []))) ?? [];
  const microDiff = diffs && diffValues.length > 0 && Math.max(...diffValues) - Math.min(...diffValues) >= NOISE_SPREAD ? diffs : null;
  const standings = displayStandings(props.series, !!props.lowerIsBetter);
  const unique = standings.leaders.length === 1 ? standings.leaders[0] : null;
  const headline =
    props.result ??
    (props.pending
      ? "Awaiting evidence · no result assigned"
      : unique
        ? `${unique.name} leads · ${standings.gap !== null ? `${gapText(standings.gap)} pts ahead` : "provisional"}`
        : standings.leaders.length > 1
          ? "Level scores · no unique leader"
          : "Waiting for matching observations");
  useEffect(() => {
    if (!expanded) return;
    modal.current?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [expanded]);
  const close = () => {
    modal.current?.close();
    setExpanded(false);
  };
  const content = (
    <>
      <p className="score-chart-source">
        {props.source}
        {props.status ? ` · ${props.status}` : ""}
      </p>
      {!props.hideLead && (
        <p
          className="score-chart-lead"
          key={`${props.pending}:${props.result}:${standings.leaders.map((l) => l.id).join()}`}
        >
          <TrendingUp size={15} />
          {headline}
        </p>
      )}
      <span className="sr-only" role="status">
        {props.result ??
          (props.hideLead
            ? "Live reference prices; no result is assigned from this chart"
            : props.pending
              ? "Evidence incomplete"
              : unique
                ? `${unique.name} is the provisional chart leader`
                : "No unique chart leader")}
      </span>
      {microDiff && (
        <p className="score-chart-note">
          <strong>Race view.</strong> Lines show the gap from the field average; {props.lowerIsBetter ? "lower" : "higher"} is ahead.
          The scale magnifies small gaps, which may reflect price precision.
        </p>
      )}
      <Plot
        key={`${props.resetKey}:${microDiff ? "gap" : "score"}`}
        {...props}
        series={microDiff ?? props.series}
        deviation={!!microDiff}
        legendSeries={props.series}
      />
      <p className="score-chart-note">
        {props.lowerIsBetter ? "Lower is better. " : ""}
        {props.note}
      </p>
    </>
  );
  return (
    <section className="score-chart" aria-label={props.title}>
      <div className="score-chart-header">
        <h2>{props.title}</h2>
        <button
          aria-label="Expand score chart"
          onClick={() => setExpanded(true)}
        >
          <Expand size={16} />
        </button>
      </div>
      {content}
      <dialog
        ref={modal}
        className="score-chart-modal"
        aria-label={`${props.title}, expanded`}
        onClose={() => setExpanded(false)}
        onCancel={close}
      >
        <div className="score-chart-header">
          <h2>{props.title}</h2>
          <button autoFocus aria-label="Close expanded chart" onClick={close}>
            <X size={20} />
          </button>
        </div>
        {expanded && content}
      </dialog>
    </section>
  );
}
