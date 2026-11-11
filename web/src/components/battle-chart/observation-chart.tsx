"use client";

import { useState } from "react";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
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
}: {
  namespace: Namespace;
  battleId: string;
  /** Token name per community index; falls back to "Community N" when absent. */
  names?: readonly string[];
}) {
  const view = useObservationChart(namespace, battleId, true);
  const [selected, setSelected] = useState("0");
  if (view.state === "loading")
    return (
      <SkeletonGroup label="Loading observations…">
        <Skeleton style={{ height: 220, borderRadius: 16 }} />
      </SkeletonGroup>
    );
  if (view.state === "unavailable" || !view.latest) {
    return (
      <p role="alert" className="text-xs text-neon-red">
        Observation evidence unavailable: {view.error ?? "no response"}. No
        sample data is shown in its place.
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
  const sourceLabel = `Persisted observations · ${data.sourceKind}${data.sourceKinds.length > 1 ? ` (${data.sourceKinds.join(", ")})` : ""} · watermark ${env.provenance.watermark ?? "none"}`;
  const status = view.stale
    ? "Stale · refresh failed, showing the last read"
    : projection
      ? `Provisional score ${projection.status}`
      : "Coverage and scores withheld";
  return (
    <section
      className="space-y-3"
      aria-label={`Observation chart for battle ${battleId}`}
    >
      {!model.drawable || model.series.length === 0 ? (
        <p role="status" className="text-xs text-mute">
          {data.items.length === 0
            ? "No samples persisted for this battle yet."
            : "This mode has no chart from the available evidence."}
        </p>
      ) : (
        <ScoreChart
          title={`Round observations · ${modeName(projection?.mode ?? data.items[0]?.mode ?? "mode")}`}
          source={sourceLabel}
          status={status}
          note={`Chart coordinates are display-only. Exact values are listed below; the contract's recorded outcome is separate. Refresh cadence is not the provider's observation cadence.`}
          series={model.series}
          selected={selected}
          onSelect={setSelected}
          duration={model.duration}
          lowerIsBetter={model.lowerIsBetter}
          pending={!provisional}
          result={
            recorded?.winner != null
              ? `Recorded result · ${who(recorded.winner)}`
              : undefined
          }
          resetKey={`${data.battleId}:${recorded?.roundId ?? ""}`}
        />
      )}
      {view.stale && (
        <p role="alert" className="text-xs text-neon-amber">
          Refresh failed ({view.error}); these samples may be out of date.
        </p>
      )}
      {view.partial && (
        <p className="text-xs text-mute">
          More samples exist than this view loads; the chart is partial.
        </p>
      )}
      {view.reconciledAtRevision !== null && (
        <p className="text-xs text-mute">
          Evidence was retracted at revision {view.reconciledAtRevision}; the
          chart was reloaded.
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
    </section>
  );
}
