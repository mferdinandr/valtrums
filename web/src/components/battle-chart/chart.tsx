"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Expand, X, TrendingUp } from "lucide-react";
import { chartSegments, displayStandings, type ChartSeries } from "./model";
import "./chart.css";

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
  range?: [number, number];
  signed?: boolean;
  resetKey?: string | number;
}
const score = (value: number, signed = true) =>
  `${signed && value > 0 ? "+" : ""}${value.toFixed(2)}%`;

function Plot({
  series,
  selected,
  onSelect,
  duration,
  connected = true,
  range,
  signed = true,
}: {
  series: ChartSeries[];
  selected: string;
  onSelect: (id: string) => void;
  duration: number;
  connected?: boolean;
  range?: [number, number];
  signed?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600),
    [sample, setSample] = useState<number | null>(null);
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
  const low = Math.min(0, ...values),
    high = Math.max(0, ...values),
    pad = Math.max(0.5, (high - low) * 0.12);
  const min = range?.[0] ?? low - pad,
    max = range?.[1] ?? high + pad,
    height = 200,
    left = 48,
    right = 22,
    top = 16,
    bottom = 30;
  const x = (t: number) =>
    left + (t / Math.max(1, duration)) * (width - left - right);
  const y = (v: number) =>
    top + ((max - v) / (max - min)) * (height - top - bottom);
  const times = [
    ...new Set(series.flatMap((s) => s.points.map((p) => p.x))),
  ].sort((a, b) => a - b);
  const inspected =
    sample === null ? null : times[Math.min(sample, times.length - 1)];
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
            duration;
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
                {value.toFixed(1)}%
              </text>
            </g>
          );
        })}
        <line
          x1={left}
          x2={width - right}
          y1={y(0)}
          y2={y(0)}
          stroke="#aebbb3"
        />
        {[0, 0.5, 1].map((t) => (
          <text
            key={t}
            x={x(t * duration)}
            y={height - 6}
            textAnchor={t === 0 ? "start" : t === 1 ? "end" : "middle"}
          >
            {connected
              ? `${Math.round(t * duration)}s`
              : t === 0
                ? "Start"
                : t === 1
                  ? "Available snapshot"
                  : ""}
          </text>
        ))}
        {[...series]
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
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray={s.inactive ? "4 4" : undefined}
                  />
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
                      {s.name}: {score(p.value!, signed)}
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
              ? "Latest"
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
        {series.map((s) => {
          const point =
            inspected === null
              ? s.points.at(-1)
              : s.points.find((p) => p.x === inspected);
          return (
            <button
              key={s.id}
              aria-pressed={selected === s.id}
              onClick={() => onSelect(s.id)}
              style={{ "--line": s.color } as React.CSSProperties}
            >
              <span className="score-chart-dot" />
              <span>
                {s.name}
                {s.inactive ? " · out" : ""}
              </span>
              <strong>
                {point?.value !== null && point?.value !== undefined
                  ? score(point.value, signed)
                  : "—"}
              </strong>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ScoreChart(props: Props) {
  const modal = useRef<HTMLDialogElement>(null),
    [expanded, setExpanded] = useState(false);
  const standings = displayStandings(props.series, !!props.lowerIsBetter);
  const unique = standings.leaders.length === 1 ? standings.leaders[0] : null;
  const headline =
    props.result ??
    (props.pending
      ? "Awaiting evidence · no result assigned"
      : unique
        ? `Latest · ${unique.name} leads${standings.gap !== null ? ` by ${standings.gap < 0.005 ? "<0.01" : standings.gap.toFixed(2)} pts` : ""}`
        : standings.leaders.length > 1
          ? "Level scores · no unique leader"
          : "Waiting for observations");
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
      <p
        className="score-chart-lead"
        key={`${props.pending}:${props.result}:${standings.leaders.map((l) => l.id).join()}`}
      >
        <TrendingUp size={15} />
        {headline}
      </p>
      <span className="sr-only" role="status">
        {props.result ??
          (props.pending
            ? "Evidence incomplete"
            : unique
              ? `${unique.name} is the provisional chart leader`
              : "No unique chart leader")}
      </span>
      <Plot key={props.resetKey} {...props} />
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
