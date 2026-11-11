"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Step } from "@/components/lifecycle-participate";
import { useWallet } from "@/components/providers";
import { useRefund } from "@/hooks/use-refund";
import { formatUnits } from "@/lib/amounts";
import { TOKEN_DECIMALS } from "@/lib/arena-read/balances";
import { applicationKey, type Namespace } from "@/lib/arena-read/application";
import type { LifecycleDetail } from "@/lib/arena-read/lifecycle";
import {
  buildCancelReview,
  cancelRequest,
  isFunded,
  MIN_FUNDED,
  utc,
  type OpenPhase,
} from "@/lib/arena-read/open-arena";

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
  name,
}: {
  namespace: Namespace;
  battleId: number | null;
  detail: LifecycleDetail;
  phase: OpenPhase;
  name: (index: number) => string;
}) {
  const communities = detail.battle.communities;
  const entered = communities.filter((c) => isFunded(c.vault)).length;
  if (phase.kind === "no_start" || phase.kind === "locked") return null;
  return (
    <Card aria-label="Open arena">
      <CardTitle>Open arena</CardTitle>
      <div role="status" aria-live="polite" className="space-y-2 text-sm leading-7">
        {phase.kind === "gathering" && (
          <p>
            Join until {utc(phase.startAtMs)}.
          </p>
        )}
        {phase.kind === "awaiting_lock" && (
          <p>Started. Waiting for the lock.</p>
        )}
        {phase.kind === "cancellable" && (
          <p>Not enough funded communities ({entered} of {MIN_FUNDED}). Anyone can cancel it; depositors then get a refund.</p>
        )}
        {phase.kind === "cancelled" && <p>Cancelled. Depositors can claim a refund.</p>}
      </div>
      {battleId === null ? null : (
        <div className="mt-6 space-y-8">
          {phase.kind === "cancellable" && <CancelStep namespace={namespace} battleId={battleId} />}
          {phase.kind === "cancelled" && <RefundStep namespace={namespace} battleId={battleId} detail={detail} name={name} />}
        </div>
      )}
    </Card>
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

/** One button that takes back everything the connected account has in a cancelled battle (positions and escrow). */
function RefundStep({ namespace, battleId, detail, name }: { namespace: Namespace; battleId: number; detail: LifecycleDetail; name: (i: number) => string }) {
  const { signIn } = useWallet();
  const refund = useRefund(namespace.arenaContract, battleId, detail.battle.communities.length, name);
  const amount = (units: string) => formatUnits(BigInt(units), TOKEN_DECIMALS, 4);
  if (!refund.connected) {
    return (
      <Button type="button" variant="ghost" onClick={() => void signIn()}>
        Connect wallet to get your refund
      </Button>
    );
  }
  if (refund.claims === null) return <p role="status" className="text-xs text-mute">Checking what you can get back…</p>;
  if (refund.claims.length === 0) {
    return (
      <p role="status" className="text-sm text-mute">
        {refund.state.step === "done" ? "Refunded. Check your wallet." : "You have nothing to refund in this battle."}
      </p>
    );
  }
  const list = refund.claims
    .map((c) => `${amount(c.amount)} ${c.kind === "position" ? name(c.community) : tokenName(c.representation)}`)
    .join(" + ");
  const st = refund.state;
  return (
    <div className="space-y-2">
      <Button type="button" onClick={refund.run} disabled={st.step === "running"}>
        {st.step === "running" ? `Refunding ${st.done} of ${st.total}…` : st.step === "failed" ? "Continue refund" : `Refund ${list}`}
      </Button>
      {st.step === "running" && <p role="status" className="text-xs text-mute">Confirm in your wallet when asked.</p>}
      {st.step === "failed" && (
        <p role="alert" className="text-xs text-neon-amber">
          Refund failed: {st.message} Press the button to continue.
        </p>
      )}
    </div>
  );
}
