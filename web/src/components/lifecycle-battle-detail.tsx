"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CrewCardSkeleton, Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import gsap from "gsap";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { LifecycleParticipate } from "@/components/lifecycle-participate";
import { MyPosition } from "@/components/my-position";
import { OpenArenaPanel } from "@/components/lifecycle-open-arena";
import { openPhase, type OpenPhase } from "@/lib/arena-read/open-arena";
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

/** Why the deposit step is closed, or null while deposits are open. */
function depositsClosed(open: OpenPhase): string | null {
  switch (open.kind) {
    case "locked":
      return "This battle is locked. Positions can no longer be registered and a deposit would be returned.";
    case "cancelled":
      return "This battle was cancelled. Deposits are closed; claim your refund in the open arena panel.";
    case "awaiting_lock":
    case "cancellable":
      return "The start time has passed. Deposits are closed and a deposit would be returned.";
    default:
      return null;
  }
}

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
  const page = useRef<HTMLDivElement>(null);
  const entered = useRef(false);
  const ready = !!data;
  // One entrance when the battle first appears: the crew cards rise in one after another.
  useEffect(() => {
    if (!ready || entered.current || !page.current) return;
    entered.current = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = gsap.context(() => {
      gsap.from(".lifecycle-crew", { autoAlpha: 0, y: 24, duration: 0.5, stagger: 0.07, ease: "power3.out", delay: 0.15, clearProps: "opacity,visibility,transform" });
    }, page.current);
    return () => ctx.revert();
  }, [ready]);
  if (loading && !data)
    return (
      <SkeletonGroup label={`Preparing battle #${battleId}…`} className="lifecycle-page">
        <div className="lifecycle-hero" aria-hidden="true">
          <div className="space-y-4">
            <Skeleton style={{ width: 150, height: 26, borderRadius: 999 }} />
            <Skeleton style={{ width: 320, height: 44 }} />
            <Skeleton style={{ width: 240, height: 16 }} />
          </div>
          <Skeleton style={{ height: 120, borderRadius: 18 }} />
        </div>
        <Skeleton style={{ height: 360, borderRadius: 24 }} />
        <div className="lifecycle-crew-grid">
          {[0, 1, 2].map((i) => <CrewCardSkeleton key={i} />)}
        </div>
      </SkeletonGroup>
    );
  if (!data)
    return (
      <Card role="alert" className="border-neon-red text-neon-red">
        Battle #{battleId} could not be loaded: {error ?? "no response"}.
        <p className="mt-3">
          <Link href="/arena" className="underline">
            Back to the battle list
          </Link>
        </p>
      </Card>
    );

  const detail = data.data;
  const status = battleStatus(detail);
  const open = openPhase(detail, now);
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
    <div ref={page} className="lifecycle-page">
      <Link href="/arena" className="text-xs text-neon-green">
        ← Back to battles
      </Link>
      <section className="lifecycle-hero">
        <div>
          <span className="lifecycle-pill">
            BATTLE #{detail.battleId}
          </span>
          <h1>{modeName(detail.battle.mode)}</h1>
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
                  : status === "cancelled"
                    ? "Cancelled"
                    : open.kind === "gathering" || open.kind === "no_start"
                      ? "Open for deposits"
                      : "Start time passed"}
            </Badge>
            {fixture && <Badge tone="amber">fixture data</Badge>}
          </div>
          <div role="status" aria-live="polite" className="text-sm leading-7">
            {phase.kind === "not_started" &&
              (status === "cancelled"
                ? "No round was played."
                : detail.battle.locked
                  ? "Waiting for round one. The recorded result will appear here."
                  : open.kind === "gathering" && now > 0
                    ? `Starts in ${formatCountdown(open.msLeft)}. No round has started.`
                    : "No round has started.")}
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
                Round results appear after the crews lock in.
              </p>
            </section>
          )
        }
      />

      {blockers.length > 0 && (
        <div className="lifecycle-callout">
          <strong>Deposits are not open yet</strong>
          <details className="lifecycle-tech">
            <summary>Why?</summary>
            <ul className="list-disc pl-4">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {safeBattleId !== null && (
        <MyPosition
          arena={namespace.arenaContract}
          battleId={safeBattleId}
          communityCount={rows.length}
          nameOf={name}
        />
      )}

      <OpenArenaPanel
        namespace={namespace}
        battleId={safeBattleId}
        detail={detail}
        phase={open}
        name={name}
      />

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
          closedReason={depositsClosed(open)}
        />
      )}

      <section aria-label="Communities">
        <div className="lifecycle-heading">
          <h2>Meet the competing crews</h2>
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
                <button
                  type="button"
                  className="lifecycle-crew-header lifecycle-crew-select"
                  aria-pressed={selected === r.representation}
                  onClick={() => setHighlighted(r.representation)}
                >
                  {r.label ? (
                    <TokenIcon symbol={displaySymbol(r.label, "")} size={44} />
                  ) : (
                    <span className="lifecycle-crew-mark" aria-hidden="true">
                      {String(r.index + 1).padStart(2, "0")}
                    </span>
                  )}
                  <h3>{name(r.index)}</h3>
                </button>
                <p className="lifecycle-amount">{exactUnits(r.vault)}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {r.recordedWinner && (
                    <Badge tone="green">recorded winner</Badge>
                  )}
                  {r.eliminated && (
                    <Badge tone="mute">eliminated · recorded candidates</Badge>
                  )}
                  <Badge tone={approved && r.audit.state === "valid" ? "green" : "amber"}>
                    {approved && r.audit.state === "valid" ? "Approved" : "Waiting for approval"}
                  </Badge>
                </div>
                <details className="lifecycle-tech">
                  <summary>Token details</summary>
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

      {detail.history && detail.history.items.length > 0 && (
        <Card>
          <CardTitle>Round history</CardTitle>
          <ul className="space-y-2 text-sm">
            {detail.history.items.map((h) => (
              <li key={h.round_id}>
                Round {h.round_id}: {h.reason}{" "}
                <Badge tone="amber">incomplete</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
