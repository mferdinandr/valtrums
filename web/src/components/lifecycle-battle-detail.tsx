"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { BattleDetailSkeleton } from "@/components/lifecycle/battle-detail-skeleton";
import gsap from "gsap";
import Link from "next/link";
import { WalletButton } from "@/components/wallet-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { JoinDeposit } from "@/components/lifecycle-join-deposit";
import { LifecycleParticipate } from "@/components/lifecycle-participate";
import { BattleResult } from "@/components/battle-result";
import { DaoDecision } from "@/components/dao-decision";
import { WinnerCelebration } from "@/components/winner-celebration";
import { MyPosition } from "@/components/my-position";
import { OpenArenaHeader, OpenArenaPanel } from "@/components/lifecycle-open-arena";
import { openPhase, type OpenPhase } from "@/lib/arena-read/open-arena";
import { LifecycleArena } from "@/components/lifecycle/lifecycle-arena";
import { startStage } from "@/components/lifecycle/battle-start-loader";
import { ScoreChart } from "@/components/battle-chart/chart";
import { ObservationChart } from "@/components/battle-chart/observation-chart";
import { lifecycleRoster } from "@/components/colosseum/lifecycle-runtime";
import { useCreatorEscrow } from "@/hooks/use-creator-escrow";
import { useLifecycleBattle } from "@/hooks/use-lifecycle-battle";
import { useNow } from "@/hooks/use-now";
import type { Namespace } from "@/lib/arena-read/application";
import {
  arenaBlockers,
  battleStatus,
  communityRows,
  communityApproval,
  roundPhase,
} from "@/lib/arena-read/lifecycle";
import {
  communityName,
  exactUnits,
  modeName,
  shortAccount,
} from "@/lib/arena-read/lifecycle-presentation";
import { formatCountdown, formatUnits } from "@/lib/amounts";
import { TOKEN_DECIMALS } from "@/lib/arena-read/balances";
import { TokenIcon } from "@/components/token-icon";
import { displaySymbol } from "@/lib/arena-read/token-style";
import "@/components/lifecycle/lifecycle.css";

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
  const [panelTab, setPanelTab] = useState<"chart" | "position">("chart");
  const escrow = useCreatorEscrow(
    namespace.arenaContract,
    /^[1-9][0-9]{0,15}$/.test(battleId) ? Number(battleId) : null,
  );
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
    return <BattleDetailSkeleton battleId={battleId} />;
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
  const stage = now > 0
    ? startStage({
        status,
        open,
        locked: detail.battle.locked,
        phaseKind: phase.kind,
        roundId: detail.round?.round_id ?? null,
      })
    : null;
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
  const actionsContent = (
      <div className="match-position-content">
      <OpenArenaHeader phase={open} />

      <div>
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
      </div>

      {safeBattleId !== null && phase.kind === "decided" && (
        <div className="space-y-4">
          <BattleResult
            arena={namespace.arenaContract}
            backings={rows.map((r) => r.representation)}
            battleId={safeBattleId}
            winner={phase.winner}
            communityCount={rows.length}
            nameOf={name}
          />
          <DaoDecision
            namespace={namespace}
            backing={rows[phase.winner]?.representation ?? ""}
            arena={namespace.arenaContract}
            battleId={safeBattleId}
            winner={phase.winner}
            communityCount={rows.length}
            nameOf={name}
          />
        </div>
      )}

      <div>
      {safeBattleId !== null && (
        <MyPosition
          arena={namespace.arenaContract}
          battleId={safeBattleId}
          communityCount={rows.length}
          nameOf={name}
        />
      )}
      </div>

      <div className="space-y-4">
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
        depositsClosed(open) !== null ? (
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
        ) : (
          <JoinDeposit
            namespace={namespace}
            battleId={safeBattleId}
            communityTokens={rows.map((r) => r.representation)}
          />
        )
      )}
      </div>

      <div className="space-y-4">
      <section aria-label="Communities">
        <div className="lifecycle-heading">
          <h2>Meet the competing crews</h2>
        </div>
        <div className="lifecycle-crew-grid mt-4">
          {rows.map((r) => {
            const approval = communityApproval(r);
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
                <p
                  className="lifecycle-amount"
                  title={`${exactUnits(r.vault)} base units (exact)`}
                >
                  {/^\d+$/.test(r.vault)
                    ? formatUnits(BigInt(r.vault), TOKEN_DECIMALS, 4)
                    : r.vault}
                </p>
                {escrow && escrow.representation === r.representation && (
                  <p className="text-xs text-neon-amber">
                    + {formatUnits(BigInt(escrow.amount), TOKEN_DECIMALS, 4)} in
                    escrow, waiting for approval
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {r.recordedWinner && (
                    <Badge tone="green">recorded winner</Badge>
                  )}
                  {r.eliminated && (
                    <Badge tone="mute">eliminated · recorded candidates</Badge>
                  )}
                  {/^\d+$/.test(r.vault) && BigInt(r.vault) > 0n && <Badge tone="green">Deposit received</Badge>}
                  {status !== "decided" && status !== "cancelled" && <Badge tone={approval.approved ? "green" : r.backing.known ? "amber" : "mute"}>
                    {approval.label}
                  </Badge>}
                </div>
                <details className="lifecycle-tech">
                  <summary>Token details</summary>
                  {(status === "decided" || status === "cancelled") && <p>Current approval: {approval.label}</p>}
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
            {detail.history.items.map((h) => {
              const outcome = h.outcome && typeof h.outcome === "object" ? h.outcome as Record<string, unknown> : null;
              const winner = outcome?.Winner && typeof outcome.Winner === "object" ? (outcome.Winner as { community?: unknown }).community : null;
              const validWinner = typeof winner === "number" && Number.isInteger(winner) && winner >= 0 && winner < rows.length;
              return <li key={h.round_id} className="flex flex-wrap items-center justify-between gap-2 border-b border-edge py-3 last:border-0">
                <strong>Round {h.round_id}</strong>
                {validWinner ? <span className="text-neon-green">Finished · Winner: {name(winner)}</span> : outcome?.Overtime ? <span>Tied · Overtime</span> : outcome?.Pending ? <span>Result pending</span> : <span className="text-mute">Result unavailable</span>}
              </li>;
            })}
          </ul>
        </Card>
      )}
      </div>
      </div>
  );
  return (
    <div ref={page} className="lifecycle-page immersive-match">
      <nav className="match-navigation" aria-label="Battle navigation">
        <Link href="/arena">← Lobby</Link>
        <span className="match-navigation-brand">VALTRUMS <span>/ ARENA</span></span>
        <WalletButton />
      </nav>
      {phase.kind === "decided" && (
        <WinnerCelebration
          key={detail.battleId}
          battleId={detail.battleId}
          winnerName={name(phase.winner)}
          winnerSymbol={rows[phase.winner]?.label ? displaySymbol(rows[phase.winner]!.label, "") : undefined}
        />
      )}
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
        scoreboard={
          <>
            <div className="match-identity">
              <span>BATTLE #{detail.battleId}</span>
              <h1>{modeName(detail.battle.mode)}</h1>
              {fixture && <span>fixture data</span>}
            </div>
            <div className="match-clock" role="timer" aria-label={phase.kind === "window_open" ? "Time remaining in round" : "Battle status"}>
              <span>{phase.kind === "window_open" ? `ROUND ${detail.round!.round_id} · TIME LEFT` : phase.kind === "not_started" && open.kind === "gathering" ? "BATTLE STARTS IN" : open.kind === "cancellable" ? "BATTLE FAILED" : "BATTLE STATUS"}</span>
              <strong>{phase.kind === "window_open" ? (now ? formatCountdown(phase.msLeft) : "—") : phase.kind === "not_started" && open.kind === "gathering" && now ? formatCountdown(open.msLeft) : phase.kind === "decided" ? "FINISHED" : phase.kind === "awaiting_resolution" ? "RESULT PENDING" : status === "cancelled" ? "CANCELLED" : open.kind === "cancellable" ? "NOT ENOUGH CREWS" : open.kind === "awaiting_lock" ? "LOCKING CREWS" : detail.battle.locked ? "OPENING ROUND" : "GET READY"}</strong>
            </div>
            <div className="match-status" role="status">
              <span>{phase.kind === "decided" ? "WINNER" : phase.kind === "window_open" ? "LIVE ROUND" : "ARENA"}</span>
              <strong>{phase.kind === "decided" ? name(phase.winner) : phase.kind === "awaiting_resolution" ? "Awaiting resolution" : status === "cancelled" ? "Cancelled" : open.kind === "cancellable" ? "Failed to start" : detail.battle.locked ? "Crews locked" : open.kind === "gathering" || open.kind === "no_start" ? "Deposits open" : "Starting soon"}</strong>
            </div>
          </>
        }
        chart={
          <div className="match-dock">
          <div className="match-dock-tabs" role="group" aria-label="Arena panel views"><button type="button" aria-pressed={panelTab === "chart"} onClick={() => setPanelTab("chart")}>Race</button><button type="button" aria-pressed={panelTab === "position"} onClick={() => setPanelTab("position")}>Position & actions</button></div>
          <div className="match-dock-panel" hidden={panelTab !== "chart"}>
          {detail.battle.locked && detail.round?.start_ns ? (
            <section>
              <ObservationChart
                namespace={namespace}
                battleId={detail.battleId}
                names={rows.map((_, i) => name(i))}
                highlightedCommunity={String(rows.find((r) => r.representation === selected)?.index ?? 0)}
                onHighlight={(id) => { const row = rows.find((r) => String(r.index) === id); if (row) setHighlighted(row.representation); }}
              />
            </section>
          ) : (
            <ScoreChart title="Race chart" source={stage?.title ?? "Waiting for the battle"} status="Not started" note="Prices will appear when the round begins." idle="The race has not started. This chart goes live when the first round opens." duration={30} pending selected={String(rows.find((r) => r.representation === selected)?.index ?? 0)} onSelect={(id) => { const row = rows.find((r) => String(r.index) === id); if (row) setHighlighted(row.representation); }} series={rows.map((r, i) => ({ id: String(r.index), name: name(r.index), color: ["#327f7d", "#ad5273", "#a8802f", "#5b6fb5", "#7c8f3a", "#8a5ca8"][i % 6]!, points: [] }))} />
          )}
          </div>
          <div className="match-dock-panel" hidden={panelTab !== "position"}>{actionsContent}</div>
          </div>
        }
      />

    </div>
  );
}
