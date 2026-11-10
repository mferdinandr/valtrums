"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { ObservationChart } from "@/components/battle-chart/observation-chart";
import { useLifecycleBattle } from "@/hooks/use-lifecycle-battle";
import { useNow } from "@/hooks/use-now";
import type { Namespace } from "@/lib/arena-read/application";
import { arenaBlockers, battleStatus, communityRows, nsToMs, roundPhase } from "@/lib/arena-read/lifecycle";
import { formatCountdown } from "@/lib/amounts";

const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";

/**
 * Authoritative lifecycle battle detail. Everything shown is a contract read or a labeled derivation:
 * the clock can say a recorded window has ended ("awaiting resolution") but never who won, and no demo
 * or legacy data is shown when a read fails. Actions are not offered here: eligibility reasons are listed
 * instead, and creating or funding a battle needs the reviewed wallet flow.
 */
export function LifecycleBattleDetail({ namespace, battleId }: { namespace: Namespace; battleId: string }) {
  const { data, loading, error, stale } = useLifecycleBattle(namespace, battleId);
  const now = useNow(1000);
  if (loading && !data) return <p role="status" className="text-sm text-mute">Loading battle #{battleId}…</p>;
  if (!data) {
    return (
      <Card role="alert" className="border-neon-red text-neon-red">
        Battle #{battleId} could not be read: {error ?? "no response"}. No demo or legacy data is shown in its place.
        <p className="mt-3"><Link href="/arena" className="underline">Back to the battle list</Link></p>
      </Card>
    );
  }
  const detail = data.data;
  const status = battleStatus(detail);
  const phase = roundPhase(detail.round, now);
  const rows = communityRows(detail, now);
  const blockers = arenaBlockers(detail.readiness);
  const fixture = data.provenance.kind === "fixture";
  const winner = detail.round?.winner ?? null;
  return (
    <div className="space-y-6">
      <Link href="/arena" className="text-xs text-neon-green">← Back to battles</Link>
      <section className="pixel-frame p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="eyebrow text-neon-green">BATTLE #{detail.battleId}</p>
            <h1 className="mt-3 text-3xl">{detail.battle.mode}</h1>
            <p className="mt-2 break-all text-xs text-mute">{namespace.deploymentId} · {namespace.network} · {namespace.arenaContract}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone={status === "decided" ? "green" : status === "locked" ? "cyan" : "amber"}>{status}</Badge>
            {fixture && <Badge tone="amber">fixture data</Badge>}
          </div>
        </div>
        <p className="mt-4 break-all text-xs text-mute">Creator: {detail.battle.creator} · communities: {detail.battle.communities.length}</p>
        <div role="status" aria-live="polite" className="mt-4 text-sm">
          {phase.kind === "not_started" && (detail.battle.locked ? "Rounds have not started yet." : "The battle is still open for deposits; no round has started.")}
          {phase.kind === "awaiting_open" && `Round ${detail.round!.round_id} has candidates ${phase.candidates.map((c) => c + 1).join(", ")} and is waiting for its window to be recorded.`}
          {phase.kind === "window_open" && (now === 0 ? "Round window recorded." : `Round ${detail.round!.round_id} window ends in ${formatCountdown(phase.msLeft)} (${when(nsToMs(detail.round!.end_ns!))}). The result comes from the contract, not this timer.`)}
          {phase.kind === "awaiting_resolution" && `Round ${detail.round!.round_id} ended at ${when(nsToMs(detail.round!.end_ns!))}. Awaiting resolution: the contract records the result from persisted evidence.`}
          {phase.kind === "decided" && `Recorded winner: community ${phase.winner + 1}.`}
        </div>
        {stale && <p role="alert" className="mt-3 text-xs text-neon-amber">Refresh failed ({error}); showing the last read.</p>}
      </section>

      <section aria-label="Communities">
        <p className="eyebrow text-neon-green">COMMUNITIES / {rows.length}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <Card key={r.index} className={r.eliminated ? "opacity-60" : undefined}>
              <p className="eyebrow">COMMUNITY {String(r.index + 1).padStart(2, "0")}</p>
              <h3 className="mt-2 break-all text-lg">{r.representation}</h3>
              <p className="mt-2 break-all text-xs text-mute">Asset {r.asset}</p>
              <p className="mt-1 break-all text-xs text-mute">{r.reference ? `Scored against mainnet reference ${r.reference}` : "No mainnet reference mapping"}</p>
              <p className="mt-2 text-sm">Vault: {r.vault} units</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {r.recordedWinner && <Badge tone="green">recorded winner</Badge>}
                {r.eliminated && <Badge tone="mute">eliminated · recorded candidates</Badge>}
                <Badge tone={r.audit.state === "valid" ? "green" : "amber"}>audit {r.audit.state}</Badge>
                <Badge tone={r.backing.known && r.backing.fresh && r.backing.trusted && r.backing.assetMatches ? "green" : "amber"}>backing {r.backing.known ? (r.backing.fresh ? "approved" : "not fresh") : "unknown"}</Badge>
              </div>
              {r.blockers.length > 0 && (
                <ul className="mt-3 list-disc pl-4 text-xs text-neon-amber" aria-label={`Why community ${r.index + 1} is not ready`}>
                  {r.blockers.map((b) => <li key={b}>{b}</li>)}
                </ul>
              )}
            </Card>
          ))}
        </div>
      </section>

      {blockers.length > 0 && (
        <Card><CardTitle>Arena readiness</CardTitle><ul className="list-disc pl-4 text-sm text-neon-amber">{blockers.map((b) => <li key={b}>{b}</li>)}</ul></Card>
      )}

      {detail.battle.locked && (
        <Card><CardTitle>Round observations</CardTitle><ObservationChart namespace={namespace} battleId={detail.battleId} /></Card>
      )}

      <Card>
        <CardTitle>Round history</CardTitle>
        {detail.history && detail.history.items.length > 0 ? (
          <ul className="space-y-2 text-sm">
            {detail.history.items.map((h) => <li key={h.round_id}>Round {h.round_id}: {h.reason} <Badge tone="amber">incomplete</Badge></li>)}
          </ul>
        ) : (
          <p className="text-sm text-mute">No stored history available. Windows, scores and evidence of earlier rounds are never reconstructed.</p>
        )}
        {winner !== null && <p className="mt-3 text-xs text-mute">The recorded winner above comes from the contract.</p>}
      </Card>

      {data.provenance.reasons.length > 0 && (
        <Card><CardTitle>Provenance</CardTitle>
          <p className="text-xs text-mute">{data.provenance.kind} · {data.provenance.health} · {data.provenance.complete ? "complete" : "partial"}</p>
          {data.provenance.reasons.map((r) => <p key={r} className="mt-1 text-xs text-mute">{r}</p>)}
        </Card>
      )}
    </div>
  );
}
