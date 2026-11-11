"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Step } from "@/components/lifecycle-participate";
import { useJoinableAssets } from "@/hooks/use-joinable-assets";
import { applicationKey, type Namespace } from "@/lib/arena-read/application";
import type { LifecycleDetail } from "@/lib/arena-read/lifecycle";
import {
  buildCancelReview,
  buildJoinReview,
  buildRefundReview,
  cancelRequest,
  isFunded,
  joinRequest,
  MIN_FUNDED,
  refundRequest,
  utc,
  type OpenPhase,
} from "@/lib/arena-read/open-arena";
import { formatCountdown } from "@/lib/amounts";

const sameAsset = (a: { chain_id: string; token_address: string }, b: { chain_id: string; token_address: string }) =>
  a.chain_id === b.chain_id && a.token_address.toLowerCase() === b.token_address.toLowerCase();

/** `backing-cashcat.valtrum-owner-b694.testnet` reads as CASHCAT; anything else shows the first account segment. */
const tokenName = (representation: string): string => {
  const first = representation.split(".")[0] ?? representation;
  return first.replace(/^backing-/, "").toUpperCase();
};

/**
 * The open arena controls of one battle (D34 to D36): start time and countdown, entered versus pending
 * communities, join by an allowlisted token, cancel when allowed and a refund per community after a cancel.
 * Each action is one reviewed wallet step; the clock only explains the phase and the contract decides.
 */
export function OpenArenaPanel({
  namespace,
  battleId,
  detail,
  phase,
  now,
  name,
}: {
  namespace: Namespace;
  battleId: number | null;
  detail: LifecycleDetail;
  phase: OpenPhase;
  now: number;
  name: (index: number) => string;
}) {
  const communities = detail.battle.communities;
  const entered = communities.filter((c) => isFunded(c.vault)).length;
  const pending = communities.length - entered;
  if (phase.kind === "no_start" || phase.kind === "locked") return null;
  return (
    <Card aria-label="Open arena">
      <CardTitle>Open arena</CardTitle>
      <div role="status" aria-live="polite" className="space-y-2 text-sm leading-7">
        {phase.kind === "gathering" && (
          <p>
            Starts {utc(phase.startAtMs)}
            {now > 0 ? ` · ${formatCountdown(phase.msLeft)} left` : ""}. Any approved token can join until then.
          </p>
        )}
        {phase.kind === "awaiting_lock" && (
          <p>The start time has passed with {entered} funded communities. Waiting for the agent to lock the battle.</p>
        )}
        {phase.kind === "cancellable" && (
          <p>
            The start time ({utc(phase.startAtMs)}) has passed with {entered} funded{" "}
            {entered === 1 ? "community" : "communities"}; at least {MIN_FUNDED} are needed. Anyone can cancel the
            battle, then every depositor claims a refund.
          </p>
        )}
        {phase.kind === "cancelled" && <p>This battle was cancelled. Every depositor can claim a refund of their own position.</p>}
        <div className="flex flex-wrap gap-2">
          <Badge tone={entered >= MIN_FUNDED ? "green" : "amber"}>{entered} entered</Badge>
          <Badge tone="mute">{pending} pending (no deposit yet)</Badge>
          {phase.kind === "cancelled" && <Badge tone="amber">cancelled</Badge>}
        </div>
        {communities.length > 0 && (
          <ul className="text-xs text-mute">
            {communities.map((c, i) => (
              <li key={c.representation}>
                {name(i)}: {isFunded(c.vault) ? "entered" : "pending"}
              </li>
            ))}
          </ul>
        )}
      </div>
      {battleId === null ? null : (
        <div className="mt-6 space-y-8">
          {phase.kind === "gathering" && <JoinStep namespace={namespace} battleId={battleId} detail={detail} />}
          {phase.kind === "cancellable" && <CancelStep namespace={namespace} battleId={battleId} />}
          {phase.kind === "cancelled" && <RefundStep namespace={namespace} battleId={battleId} detail={detail} name={name} />}
        </div>
      )}
    </Card>
  );
}

function JoinStep({ namespace, battleId, detail }: { namespace: Namespace; battleId: number; detail: LifecycleDetail }) {
  const joinable = useJoinableAssets(namespace.arenaContract);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const full = detail.battle.communities.length >= 16;
  const options = useMemo(
    () =>
      (joinable.items ?? []).map((a) => ({
        representation: a.representation,
        label: tokenName(a.representation),
        joined: detail.battle.communities.some((c) => c.representation === a.representation || sameAsset(c, a)),
      })),
    [joinable.items, detail.battle.communities],
  );
  const picked = options.find((o) => o.representation === choice);
  const review = useMemo(
    () => buildJoinReview(namespace.arenaContract, battleId, choice, picked?.label),
    [namespace.arenaContract, battleId, choice, picked?.label],
  );
  const request = useMemo(() => joinRequest(battleId, choice), [battleId, choice]);
  if (joinable.error) return <p role="alert" className="text-xs text-neon-red">The joinable tokens could not be read: {joinable.error}</p>;
  if (!joinable.items) return <p role="status" className="text-xs text-mute">Reading the joinable tokens…</p>;
  if (options.length === 0) return <p className="text-xs text-mute">The arena has no joinable tokens yet.</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Token to join with">
        {options.map((o) => (
          <Button
            key={o.representation}
            type="button"
            variant="ghost"
            disabled={busy || (full && !o.joined)}
            aria-pressed={choice === o.representation}
            onClick={() => setChoice(o.representation)}
            className={choice === o.representation ? "border-neon-green text-neon-green" : ""}
          >
            {o.label}
            {o.joined ? " · in the arena" : ""}
          </Button>
        ))}
      </div>
      {full && <p className="text-xs text-mute">The arena has 16 communities: you can still join one of them.</p>}
      {choice && (
        <Step
          key={`join-${choice}`}
          title={picked?.joined ? "Join this crew (saves your spot)" : "Join with this token (adds its crew)"}
          review={review}
          request={request}
          namespaceKey={applicationKey(namespace)}
          onSigningChange={setBusy}
          busyElsewhere={false}
        />
      )}
    </div>
  );
}

const ignoreSigning = (): void => undefined;

function CancelStep({ namespace, battleId }: { namespace: Namespace; battleId: number }) {
  const review = useMemo(() => buildCancelReview(namespace.arenaContract, battleId), [namespace.arenaContract, battleId]);
  const request = useMemo(() => cancelRequest(battleId), [battleId]);
  return (
    <Step
      title="Cancel the battle"
      review={review}
      request={request}
      namespaceKey={applicationKey(namespace)}
      onSigningChange={ignoreSigning}
      busyElsewhere={false}
    />
  );
}

function RefundStep({ namespace, battleId, detail, name }: { namespace: Namespace; battleId: number; detail: LifecycleDetail; name: (i: number) => string }) {
  const funded = detail.battle.communities.map((c, i) => ({ index: i, funded: isFunded(c.vault) })).filter((c) => c.funded);
  const [community, setCommunity] = useState<number | null>(funded[0]?.index ?? null);
  const [busy, setBusy] = useState(false);
  const review = useMemo(
    () => buildRefundReview(namespace.arenaContract, battleId, community ?? -1, community === null ? undefined : name(community)),
    [namespace.arenaContract, battleId, community, name],
  );
  const request = useMemo(() => refundRequest(battleId, community ?? -1), [battleId, community]);
  if (funded.length === 0) return <p className="text-xs text-mute">No community holds a deposit, so there is nothing to refund.</p>;
  return (
    <div className="space-y-4">
      <p className="text-xs text-mute">Pick the community you deposited in. The arena refunds only your own position.</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Community to refund from">
        {funded.map((c) => (
          <Button
            key={c.index}
            type="button"
            variant="ghost"
            disabled={busy}
            aria-pressed={community === c.index}
            onClick={() => setCommunity(c.index)}
            className={community === c.index ? "border-neon-green text-neon-green" : ""}
          >
            {name(c.index)}
          </Button>
        ))}
      </div>
      {community !== null && (
        <Step
          key={`refund-${community}`}
          title="Claim your refund"
          review={review}
          request={request}
          namespaceKey={applicationKey(namespace)}
          onSigningChange={setBusy}
          busyElsewhere={false}
        />
      )}
    </div>
  );
}
