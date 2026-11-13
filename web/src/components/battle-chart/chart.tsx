"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Expand, X, TrendingUp } from "lucide-react";
import { chartSegments, clipToPlayhead, displayStandings, relativeToLeader, scoresDiffer, type ChartSeries } from "./model";
import "./chart.css";
import { TokenIcon } from "@/components/token-icon";

/** Length in px of one colour stripe where several series coincide. */
const STRIPE = 7;

interface Geometry {
  min: number;
  max: number;
  /** Magnifying scale of the race view (asinh), eased like the axis so a new sample never rescales the lines at once. */
  scale: number;
  /** Round time (s) up to which the lines are drawn. */
  playhead: number;
}

/** Bounds of the playback delay (s) behind the newest sample. */
const MIN_PLAYBACK_LAG_S = 1.2;
const MAX_PLAYBACK_LAG_S = 4.5;
/** Further behind than this (e.g. after a hidden tab), the playhead jumps instead of racing to catch up. */
const CATCH_UP_LIMIT_S = 6;
/** Near the newest sample the playhead slows with this time constant (s) instead of stopping dead. */
const ARRIVAL_EASE_S = 0.6;

/**
 * Playback delay for the observed sample spacing: the widest of the recent gaps between samples plus
 * a margin for polling, so the next real sample is normally known before the line reaches the last one.
 */
export function playbackLag(times: readonly number[]): number {
  const recent = times.slice(-10);
  let widest = 0;
  for (let i = 1; i < recent.length; i++) widest = Math.max(widest, recent[i]! - recent[i - 1]!);
  return Math.min(MAX_PLAYBACK_LAG_S, Math.max(MIN_PLAYBACK_LAG_S, widest + 0.6));
}

/**
 * Drives a playhead that moves through round time at a steady real-time speed, `lagS` behind the
 * newest sample, so the drawn line advances continuously like buffered video instead of jumping once
 * per sample. Drawing happens only between recorded samples; nothing is extrapolated. If samples stop,
 * the playhead glides into the newest one and rests there. Drift is absorbed by gently changing speed.
 * A recorded result or reduced motion shows everything at once. The axis range and the race-view scale
 * glide toward their targets with an eased motion.
 */
function useChartPlayback(targetMin: number, targetMax: number, targetScale: number, newestX: number, live: boolean, lagS: number): Geometry {
  const [, frame] = useState(0);
  const current = useRef<Geometry | null>(null);
  const arrival = useRef<{ at: number; newestX: number }>({ at: 0, newestX });
  const target = useRef({ min: targetMin, max: targetMax, scale: targetScale, newestX, live, lagS });
  target.current = { min: targetMin, max: targetMax, scale: targetScale, newestX, live, lagS };
  if (!current.current) {
    current.current = {
      min: targetMin,
      max: targetMax,
      scale: targetScale,
      playhead: live ? newestX - lagS : newestX,
    };
  }
  // Remember when a newer sample arrived; that wall-clock moment anchors where the playhead should be.
  useEffect(() => {
    const a = arrival.current;
    if (newestX !== a.newestX || a.at === 0) a.at = performance.now();
    a.newestX = newestX;
  }, [newestX]);

  useEffect(() => {
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let previousFrame: number | undefined;
    const step = (now: number) => {
      const t = target.current;
      const c = current.current!;
      const elapsed = previousFrame === undefined ? 16 : Math.min(now - previousFrame, 100);
      previousFrame = now;
      const k = reduce ? 1 : 1 - Math.exp(-elapsed / 450);
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
      c.scale = ease(c.scale, t.scale, Math.max(Math.abs(t.scale), Number.MIN_VALUE));
      if (Number.isFinite(t.newestX)) {
        const since = (now - arrival.current.at) / 1000;
        // Where the playhead belongs: a delay behind live, never past the newest real sample.
        const goal = t.live && !reduce ? Math.min(t.newestX, t.newestX - t.lagS + Math.max(0, since)) : t.newestX;
        if (reduce || !Number.isFinite(c.playhead) || c.playhead > t.newestX || goal - c.playhead > CATCH_UP_LIMIT_S) {
          c.playhead = goal;
        } else {
          // Real-time speed, nudged a little faster or slower to stay on the delay without visible jumps,
          // and easing into the newest sample when nothing newer has arrived yet.
          const headroom = t.newestX - c.playhead;
          const rate = Math.min(2.5, Math.max(0.4, 1 + (goal - c.playhead) * 0.5), headroom / ARRIVAL_EASE_S);
          c.playhead = headroom < 0.002 ? t.newestX : Math.min(t.newestX, c.playhead + (rate * elapsed) / 1000);
        }
        if (c.playhead < t.newestX) moving = true;
      }
      frame((n) => n + 1);
      if (moving) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [targetMin, targetMax, targetScale, newestX, live, lagS]);
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
  /** The race has not started: the chart is dimmed and inert and says why, instead of showing evidence states. */
  idle?: string;
}
const score = (value: number, signed = true, digits = 2) =>
  `${signed && value > 0 ? "+" : ""}${value.toFixed(digits)}%`;

/**
 * Decimals needed for the given scores to read as different numbers (2 to 12). Scores that are still equal at
 * 12 decimals stay equal: a real tie is shown as a tie, never stretched into a fake difference.
 */
export const MAX_SCORE_DIGITS = 16;
/** Most decimals a legend chip shows; the exact value stays in its tooltip. */
export const LEGEND_MAX_DIGITS = 14;
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
  const stickyDigits = useRef(2);
  const stickyScoreChars = useRef(0);
  const [width, setWidth] = useState(600),
    [sample, setSample] = useState<number | null>(null);
  useEffect(() => { if (result) setSample(null); }, [result]);
  const start = 0, end = duration;
  // A symmetric logarithmic scale keeps tiny gaps legible across the whole round while compressing spikes.
  const magnitudes = allSeries.flatMap((s) => s.points.flatMap((p) => p.value !== null && Number.isFinite(p.value) && p.value !== 0 ? [Math.abs(p.value)] : [])).sort((a, b) => a - b);
  const linearScale = magnitudes[Math.floor(magnitudes.length / 2)] ?? 1;
  const transformWith = (scale: number) => (s: ChartSeries): ChartSeries =>
    deviation ? { ...s, points: s.points.map((p) => ({ ...p, value: p.value === null ? null : Math.asinh(p.value / scale) })) } : s;
  // Target geometry (axis fit, overlap detection, sample times) uses the scale of the current data;
  // the lines are drawn with the eased scale below so a new sample never rescales them at once.
  const series = allSeries.map(transformWith(linearScale));
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
  // Presentation only: lines are played back slightly behind the newest sample so they draw continuously.
  // No value is invented; when playback ends every drawn point sits exactly on its recorded sample.
  const newestX = points.length ? Math.max(...points.map((p) => p.x)) : Number.NaN;
  const sampleTimes = [...new Set(points.map((p) => p.x))].sort((a, b) => a - b);
  const smooth = useChartPlayback(targetMin, targetMax, linearScale, newestX, connected && !result, playbackLag(sampleTimes));
  const inverse = (v: number) => (deviation ? Math.sinh(v) * smooth.scale : v);
  const drawSeries = allSeries.map(transformWith(smooth.scale));
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
  // Scores that differ only below NOISE_SPREAD moved together; a note under the legend says so.
  const level = legendValues.length > 1 && Math.max(...legendValues) !== Math.min(...legendValues) && Math.max(...legendValues) - Math.min(...legendValues) < NOISE_SPREAD;
  // Legend chips keep a fixed width. The scores show as many decimals as it takes to tell them apart, up
  // to LEGEND_MAX_DIGITS, and that count only grows within a round. The number column is reserved for the
  // longest possible text from the start, so a jump in decimals never resizes or shifts a chip.
  const legendDigits = (stickyDigits.current = Math.max(stickyDigits.current, Math.min(LEGEND_MAX_DIGITS, scoreDigits(legendValues))));
  const scoreChars = (stickyScoreChars.current = Math.max(
    stickyScoreChars.current,
    ...legendValues.map((v) => score(v, signed, LEGEND_MAX_DIGITS).length),
  ));
  const nameChars = Math.max(0, ...legendRows.map((s) => s.name.length + (s.inactive ? 6 : 0)));
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
        {[...drawSeries]
          .map((s) => (connected && Number.isFinite(smooth.playhead) ? { ...s, points: clipToPlayhead(s.points, smooth.playhead) } : s))
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
                      {s.name}: {deviation ? (inverse(p.value!) === 0 ? "leading" : `${Math.abs(inverse(p.value!)).toExponential(3)} points behind the leader`) : score(p.value!, signed)}
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
        style={{ "--score-ch": `${scoreChars}ch`, "--token-ch": `${nameChars}ch` } as React.CSSProperties}
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
              {ranks && (
                // Always present so the chip does not resize when a rank appears or disappears.
                <span className="score-chart-rank" aria-hidden={inspected !== null || !ranks.some((r) => String(r.community) === s.id)}>
                  {inspected === null ? ranks.find((r) => String(r.community) === s.id)?.rank : null}
                </span>
              )}
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
          {deviation
            ? "Prices moved together: scores match to 6 decimals. The smaller differences between tokens are magnified in the race view above."
            : "Prices moved together: scores are level to 6 decimals. Differences below that are rounding noise."}
        </p>
      )}
    </div>
  );
}

export function ScoreChart(props: Props) {
  const modal = useRef<HTMLDialogElement>(null),
    [expanded, setExpanded] = useState(false);
  // The companion strip exists only for a connected round chart of two or more tokens whose scores differ at all.
  const diffs = props.connected !== false && !props.range && props.series.length >= 2 ? relativeToLeader(props.series, !!props.lowerIsBetter) : null;
  // Exact scores switch to the race view at the first real difference, even in the 13th or 14th decimal,
  // so the lines separate from the first seconds. Float-only series keep the rounding-noise floor.
  const microDiff = diffs && scoresDiffer(diffs, NOISE_SPREAD) ? diffs : null;
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
      {!props.hideLead && !props.idle && (
        <p
          className="score-chart-lead"
          key={`${props.pending}:${props.result}:${standings.leaders.map((l) => l.id).join()}`}
        >
          <TrendingUp size={15} />
          {headline}
        </p>
      )}
      <span className="sr-only" role="status">
        {props.idle ??
          props.result ??
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
          <strong>Race view.</strong> The leader sits on the top line; every other token is drawn below by how far it trails.
          The scale magnifies small gaps, which may reflect price precision.
        </p>
      )}
      {props.idle && <p className="score-chart-idle">{props.idle}</p>}
      <div className="score-chart-body" inert={!!props.idle}>
        <Plot
          key={`${props.resetKey}:${microDiff ? "gap" : "score"}`}
          {...props}
          series={microDiff ?? props.series}
          deviation={!!microDiff}
          legendSeries={props.series}
        />
        {!props.idle && (
          <p className="score-chart-note">
            {props.lowerIsBetter ? "Lower is better. " : ""}
            {props.note}
          </p>
        )}
      </div>
    </>
  );
  return (
    <section className={props.idle ? "score-chart is-idle" : "score-chart"} aria-label={props.title}>
      <div className="score-chart-header">
        <h2>{props.title}</h2>
        <button
          aria-label="Expand score chart"
          disabled={!!props.idle}
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
