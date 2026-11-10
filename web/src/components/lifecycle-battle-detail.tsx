"use client";

import { useState, type CSSProperties } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { LifecycleParticipate } from "@/components/lifecycle-participate";
import { LifecycleArena } from "@/components/lifecycle/lifecycle-arena";
import { ObservationChart } from "@/components/battle-chart/observation-chart";
import { ReferencePreviewChart } from "@/components/battle-chart/reference-preview";
import { lifecycleRoster } from "@/components/colosseum/lifecycle-runtime";
import { useLifecycleBattle } from "@/hooks/use-lifecycle-battle";
import { useNow } from "@/hooks/use-now";
import type { Namespace } from "@/lib/arena-read/application";
import {
  arenaBlockers,
  battleStatus,
  communityRows,
  nsToMs,
  roundPhase,
} from "@/lib/arena-read/lifecycle";
import {
  communityName,
  exactUnits,
  modeName,
  shortAccount,
} from "@/lib/arena-read/lifecycle-presentation";
import { formatCountdown } from "@/lib/amounts";
import { TokenIcon } from "@/components/token-icon";
import { displaySymbol } from "@/lib/arena-read/token-style";
import "@/components/lifecycle/lifecycle.css";

const when = (ms: number) =>
  new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";

export function LifecycleBattleDetail({
  namespace,
  battleId,
}: {
  namespace: Namespace;
  battleId: string;
}) {
  const { data, loading, error, stale } = useLifecycleBattle(
    namespace,
    battleId,
  );
  const [highlighted, setHighlighted] = useState("");
  const now = useNow(1000);
  if (loading && !data)
    return (
      <p role="status" className="text-sm text-mute">
        Preparing battle #{battleId}…
      </p>
    );
  if (!data)
    return (
      <Card role="alert" className="border-neon-red text-neon-red">
        Battle #{battleId} could not be read: {error ?? "no response"}. No demo
        or legacy data is shown in its place.
        <p className="mt-3">
          <Link href="/arena" className="underline">
            Back to the battle list
          </Link>
        </p>
      </Card>
    );

  const detail = data.data;
  const status = battleStatus(detail);
  const phase = roundPhase(detail.round, now);
  const rows = communityRows(detail, now);
  const roster = lifecycleRoster(detail.battle.communities);
  const selected = rows.some((r) => r.representation === highlighted)
    ? highlighted
    : (rows[0]?.representation ?? "");
  const blockers = arenaBlockers(detail.readiness);
  const fixture = data.provenance.kind === "fixture";
  const name = (i: number) =>
    roster[i]?.generic
      ? (rows[i]?.label ? displaySymbol(rows[i]!.label, communityName(i)) : communityName(i))
      : (roster[i]?.name ?? communityName(i));
  const safeBattleId =
    BigInt(detail.battleId) <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(detail.battleId)
      : null;
  return (
    <div className="lifecycle-page">
      <Link href="/arena" className="text-xs text-neon-green">
        ← Back to battles
      </Link>
      <section className="lifecycle-hero">
        <div>
          <span className="lifecycle-pill">
            BATTLE #{detail.battleId} · {rows.length} crews
          </span>
          <h1>{modeName(detail.battle.mode)}</h1>
          <p className="text-sm text-mute">
            {detail.battle.locked
              ? "Your crews are in. Follow the round, inspect the evidence and cheer on your community."
              : "Meet the crews. Pick your community, review your deposit and bring a little energy."}
          </p>
          <div className="lifecycle-facts">
            <span>30-second rounds</span>
            <span>Original-token rewards</span>
            <span>
              {fixture ? "Fixture data · not a live battle" : namespace.network}
            </span>
          </div>
        </div>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Badge
              tone={
                status === "decided"
                  ? "green"
                  : status === "locked"
                    ? "cyan"
                    : "amber"
              }
            >
              {status === "decided"
                ? "Result recorded"
                : status === "locked"
                  ? "Crews locked in"
                  : "Open for deposits"}
            </Badge>
            {fixture && <Badge tone="amber">fixture data</Badge>}
          </div>
          <div role="status" aria-live="polite" className="text-sm leading-7">
            {phase.kind === "not_started" &&
              (detail.battle.locked
                ? "Waiting for round one. The recorded result will appear here."
                : "The battle is still open for deposits; no round has started.")}
            {phase.kind === "awaiting_open" &&
              `Round ${detail.round!.round_id} is preparing its next window. ${phase.candidates.length} crews remain.`}
            {phase.kind === "window_open" &&
              (now === 0
                ? "Round window recorded."
                : `Round ${detail.round!.round_id} · ${formatCountdown(phase.msLeft)} left. The timer does not decide the winner.`)}
            {phase.kind === "awaiting_resolution" &&
              `Round ${detail.round!.round_id} ended at ${when(nsToMs(detail.round!.end_ns!))}. Awaiting resolution from recorded evidence.`}
            {phase.kind === "decided" &&
              `Recorded winner: ${name(phase.winner)}. Rewards and held principal remain separate.`}
          </div>
        </div>
      </section>

      {stale && (
        <p role="alert" className="lifecycle-callout">
          Refresh failed ({error}); showing the last read. The arena does not
          invent a new result.
        </p>
      )}

      <LifecycleArena
        detail={detail}
        selected={selected}
        onSelect={setHighlighted}
        fixture={fixture}
        chart={
          detail.battle.locked ? (
            <section>
              <h2 className="my-3 text-lg">Round observations</h2>
              <ObservationChart
                namespace={namespace}
                battleId={detail.battleId}
              />
            </section>
          ) : (
            <section>
              <h2 className="my-3 text-lg">Live price preview</h2>
              <ReferencePreviewChart
                symbols={rows.map((r) =>
                  displaySymbol(r.label, communityName(r.index)),
                )}
              />
              <p className="py-3 text-sm text-mute">
                Round observations appear once the crews lock in and evidence
                is available.
              </p>
            </section>
          )
        }
      />

      <section aria-label="Communities">
        <div className="lifecycle-heading">
          <h2>Meet the competing crews</h2>
          <p className="text-xs text-mute">
            Highlighting a crew never changes your deposit.
          </p>
        </div>
        <div className="lifecycle-crew-grid mt-4">
          {rows.map((r) => {
            const approved =
              r.backing.known &&
              r.backing.fresh &&
              r.backing.trusted &&
              r.backing.assetMatches;
            return (
              <Card
                key={r.index}
                className={`lifecycle-crew ${r.eliminated ? "opacity-60" : ""}`}
                data-selected={selected === r.representation}
                style={
                  { "--crew-color": roster[r.index]?.color } as CSSProperties
                }
              >
                <div className="lifecycle-crew-header">
                  <span className="lifecycle-crew-mark" aria-hidden="true">
                    {String(r.index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <p className="eyebrow text-mute">
                      {communityName(r.index)}
                    </p>
                    <h3 className="token-title">
                      {r.label && <TokenIcon symbol={displaySymbol(r.label, "")} size={28} />}
                      {name(r.index)}
                    </h3>
                  </div>
                </div>
                <p className="lifecycle-amount">{exactUnits(r.vault)}</p>
                <p className="text-xs text-mute">
                  Vault · exact base units · token decimals unavailable
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {r.recordedWinner && (
                    <Badge tone="green">recorded winner</Badge>
                  )}
                  {r.eliminated && (
                    <Badge tone="mute">eliminated · recorded candidates</Badge>
                  )}
                  <Badge tone={r.audit.state === "valid" ? "green" : "amber"}>
                    audit {r.audit.state}
                  </Badge>
                  <Badge tone={approved ? "green" : "amber"}>
                    backing{" "}
                    {approved
                      ? "approved"
                      : r.backing.known
                        ? "not ready"
                        : "unknown"}
                  </Badge>
                </div>
                <button
                  type="button"
                  className="mt-4 text-xs font-semibold text-neon-green underline"
                  onClick={() => setHighlighted(r.representation)}
                >
                  Highlight {name(r.index)}
                </button>
                {!detail.battle.locked && r.blockers.length > 0 && (
                  <ul
                    className="mt-3 list-disc pl-4 text-xs text-neon-amber"
                    aria-label={`Why community ${r.index + 1} is not ready`}
                  >
                    {r.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                )}
                <details className="lifecycle-tech">
                  <summary>Asset identity &amp; evidence</summary>
                  {r.label && (
                    <p>
                      Token label: {displaySymbol(r.label, "")} ({r.label.name}). A display name only; the identity is the chain
                      and address below.
                    </p>
                  )}
                  <p>Representation: {r.representation}</p>
                  <p>Source asset: {r.asset}</p>
                  <p>Cosmetic artwork is not token approval.</p>
                  {!roster[r.index]?.generic &&
                    roster[r.index]?.visualReference.status ===
                      "unverified" && (
                      <p>
                        This character artwork is an unverified interpretation.
                      </p>
                    )}
                </details>
              </Card>
            );
          })}
        </div>
      </section>

      {blockers.length > 0 && (
        <div className="lifecycle-callout">
          <strong>Arena readiness</strong>
          <ul className="list-disc pl-4">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {safeBattleId === null ? (
        <Card role="status">
          Wallet actions are unavailable for this ID until the action service
          supports it losslessly. Read-only arena and evidence remain available.
        </Card>
      ) : (
        <LifecycleParticipate
          namespace={namespace}
          battleId={safeBattleId}
          communities={rows.map((r) => ({
            index: r.index,
            representation: r.representation,
            label: name(r.index),
          }))}
          locked={detail.battle.locked}
        />
      )}

      <Card>
        <CardTitle>Round history</CardTitle>
        {detail.history && detail.history.items.length > 0 ? (
          <ul className="space-y-2 text-sm">
            {detail.history.items.map((h) => (
              <li key={h.round_id}>
                Round {h.round_id}: {h.reason}{" "}
                <Badge tone="amber">incomplete</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-mute">
            No stored history available. Windows, scores and evidence of earlier
            rounds are never reconstructed.
          </p>
        )}
        <details className="lifecycle-tech">
          <summary>Battle identity &amp; data provenance</summary>
          <p>
            Deployment: {namespace.deploymentId} · {namespace.network} ·{" "}
            {namespace.arenaContract}
          </p>
          <p>
            Creator: {detail.battle.creator} (
            {shortAccount(detail.battle.creator)})
          </p>
          <p>
            {data.provenance.kind} · {data.provenance.health} ·{" "}
            {data.provenance.complete ? "complete" : "partial"}
          </p>
          {data.provenance.reasons.map((r) => (
            <p key={r}>{r}</p>
          ))}
        </details>
      </Card>
    </div>
  );
}
