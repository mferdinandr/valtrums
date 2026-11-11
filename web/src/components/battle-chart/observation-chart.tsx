"use client";

import { useEffect, useState } from "react";
import { RaceChartSkeleton } from "./loading";
import { useObservationChart } from "@/hooks/use-observation-chart";
import type { Namespace } from "@/lib/arena-read/application";
import { ScoreChart } from "./chart";
import { exactScoreText, observationSeries, withNames } from "./observation-series";
import { modeName } from "@/lib/arena-read/lifecycle-presentation";

/**
 * Chart of persisted observation evidence for one battle. It shows only what the backend served: an
 * unavailable service is an explicit message, never demo or fixture data in its place. Provisional
 * values and the contract's recorded outcome are shown separately, and nothing here picks a winner.
 */
export function ObservationChart({
  namespace,
  battleId,
  names,
  highlightedCommunity,
  onHighlight,
  onStandings,
}: {
  namespace: Namespace;
  battleId: string;
  /** Token name per community index; falls back to "Community N" when absent. */
  names?: readonly string[];
  highlightedCommunity?: string;
  onHighlight?: (id: string) => void;
  onStandings?: (rows: { community: number; rank: number }[]) => void;
}) {
  const view = useObservationChart(namespace, battleId, true);
  const [selected, setSelected] = useState("0");
  const [ranks, setRanks] = useState<{ community: number; rank: number }[]>([]);
  useEffect(() => {
    const projection = view.latest?.data.projection;
    if (view.stale || projection?.status !== "provisional") { setRanks([]); onStandings?.([]); return; }
    const scores = projection.scores.filter((s) => s !== null);
    const compare = (a: typeof scores[number], b: typeof scores[number]) => {
      const delta = BigInt(a.numerator) * (a.negative ? -1n : 1n) * BigInt(b.denominator) - BigInt(b.numerator) * (b.negative ? -1n : 1n) * BigInt(a.denominator);
      return (delta > 0n ? -1 : delta < 0n ? 1 : 0) * (projection.mode === "LowestDrawdown" ? -1 : 1);
    };
    scores.sort(compare);
    let rank = 1;
    const rows = scores.map((s, i) => { if (i && compare(s, scores[i - 1]!) !== 0) rank = i + 1; return { community: s.community, rank }; });
    setRanks(rows); onStandings?.(rows);
  }, [view.latest, view.stale, onStandings]);
  if (view.state === "loading")
    return (
      <RaceChartSkeleton />
    );
  if (view.state === "unavailable" || !view.latest) {
    return (
      <p role="alert" className="text-xs text-neon-red">
        Price chart unavailable. Please try again later.
      </p>
    );
  }
  const env = view.latest;
  const data = { ...env.data, items: view.items };
  const model = observationSeries(data, names);
  const who = (community: number): string => names?.[community] ?? `community ${community + 1}`;
  const projection = data.projection;
  const recorded = data.recorded;
  const provisional = projection?.status === "provisional";
  const sourceLabel = view.stale ? "Updates delayed" : recorded?.winner != null ? "Round complete" : "Round in progress";
  const status = view.stale
    ? "Last available update"
    : provisional ? "Live standings are provisional" : "Waiting for price data";
  return (
    <section
      className="space-y-3"
      aria-label={`Observation chart for battle ${battleId}`}
    >
      {!model.drawable || model.series.length === 0 ? (
        <p role="status" className="text-xs text-mute">
          {data.items.length === 0
            ? "Waiting for price data."
            : "The chart is not available for this round."}
        </p>
      ) : (
        <ScoreChart
          title={`Race chart · ${modeName(projection?.mode ?? data.items[0]?.mode ?? "mode")}`}
          source={sourceLabel}
          status={status}
          note="Standings are provisional until the result is confirmed."
          series={model.series}
          ranks={ranks}
          selected={highlightedCommunity ?? selected}
          onSelect={(id) => { setSelected(id); onHighlight?.(id); }}
          duration={model.duration}
          lowerIsBetter={model.lowerIsBetter}
          pending={!provisional}
          closingTimes={recorded?.winner != null && recorded.startNs ? data.boundaries?.flatMap((b) => b.end?.observedAtMs ? [Number(BigInt(b.end.observedAtMs) - BigInt(recorded.startNs!) / 1_000_000n) / 1000] : []) : undefined}
          result={
            recorded?.winner != null
              ? `Winner · ${who(recorded.winner)}`
              : undefined
          }
          resetKey={`${data.battleId}:${recorded?.roundId ?? ""}`}
        />
      )}
      {view.stale && (
        <p role="alert" className="text-xs text-neon-amber">
          Updates are delayed. Showing the last available prices.
        </p>
      )}
      {view.partial && (
        <p className="text-xs text-mute">
          More samples exist than this view loads; the chart is partial.
        </p>
      )}
      {model.drawable && <p className="px-3 text-xs text-mute">Round timeline: 0–{model.duration}s · latest plotted price at {Math.max(0, ...model.series.flatMap((s) => s.points.filter((p) => p.value !== null).map((p) => p.x))).toFixed(1)}s</p>}
      {(view.reconciledAtRevision !== null || model.gapNotes.length > 0 || projection?.status === "incomplete") && <p className="text-xs text-neon-amber">Some price data is missing or has changed.</p>}
      <details className="chart-details">
      <summary>Price details</summary>
      {recorded?.winner != null && data.boundaries && recorded.startNs && (
        <p className="text-xs text-mute">
          Estimated closing samples: {data.boundaries.map((b) => {
            const time = b.end?.observedAtMs;
            return `${who(b.community)} ${time ? `${(Number(BigInt(time) - BigInt(recorded.startNs!) / 1_000_000n) / 1000).toFixed(1)}s` : "unavailable"}`;
          }).join(" · ")}. The recorded result is authoritative; submitted sample identities are not available here.
        </p>
      )}
      {projection && projection.scores.some(Boolean) && (
        <p className="break-all text-xs">
          Provisional exact scores (not a result):{" "}
          {projection.scores
            .map(
              (s, i) =>
                `${who(s?.community ?? i)} ${s ? exactScoreText(s) : "unavailable"}`,
            )
            .join(" · ")}
          {provisional && projection.provisionalLeaders.length > 0
            ? ` · provisional leader: ${projection.provisionalLeaders.map((c) => who(c)).join(", ")}`
            : ""}
        </p>
      )}
      {[
        ...model.gapNotes,
        ...(projection?.status === "incomplete" ? projection.reasons : []),
        ...env.provenance.reasons,
      ].map((r) => (
        <p key={r} className="text-xs text-mute">
          {withNames(r, names)}
        </p>
      ))}
      </details>
    </section>
  );
}
