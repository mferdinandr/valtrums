"use client";

import { useMemo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { TransactionLink } from "@/components/transaction-link";
import { Card } from "@/components/ui/card";
import { Step } from "@/components/lifecycle-participate";
import { useWallet } from "@/components/providers";
import { useNow } from "@/hooks/use-now";
import { useRefund } from "@/hooks/use-refund";
import { formatUnits } from "@/lib/amounts";
import { TOKEN_DECIMALS } from "@/lib/arena-read/balances";
import { applicationKey, type Namespace } from "@/lib/arena-read/application";
import type { LifecycleDetail } from "@/lib/arena-read/lifecycle";
import {
  buildCancelReview,
  cancelRequest,
  isFunded,
  localTime,
  MIN_FUNDED,
  type OpenPhase,
} from "@/lib/arena-read/open-arena";

/** `backing-cashcat.valtrum-owner-b694.testnet` reads as CASHCAT; anything else shows the first account segment. */
const tokenName = (representation: string): string => {
  const first = representation.split(".")[0] ?? representation;
  return first.replace(/^backing-/, "").toUpperCase();
};

/**
 * The open arena status shown above everything else, without a card: the title, then one line under it. The join
 * deadline is in the viewer's own time zone, so it appears once the page is in the browser (the server has no zone).
 */
export function OpenArenaHeader({ phase }: { phase: OpenPhase }) {
  const inBrowser = useNow(3_600_000) > 0;
  if (phase.kind === "no_start" || phase.kind === "locked") return null;
  return (
    <div role="status" aria-live="polite" className="text-center">
      <p className="text-base font-bold uppercase tracking-wide">Open arena</p>
      {phase.kind === "gathering" && inBrowser && <p className="text-sm text-mute">Join until {localTime(phase.startAtMs)}</p>}
      {phase.kind === "awaiting_lock" && <p className="text-sm text-mute">Started, waiting for the lock</p>}
      {phase.kind === "cancellable" && <p className="text-sm text-mute">Not enough funded communities</p>}
      {phase.kind === "cancelled" && <p className="text-sm text-mute">Cancelled</p>}
    </div>
  );
}

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
  if (phase.kind !== "cancellable" && phase.kind !== "cancelled") return null;
  const entered = detail.battle.communities.filter((c) => isFunded(c.vault)).length;
  return (
    <Card aria-label="Open arena">
      {phase.kind === "cancellable" && (
        <p className="text-sm">
          Not enough funded communities ({entered} of {MIN_FUNDED}). The battle is cancelled and depositors get a refund.
        </p>
      )}
      {phase.kind === "cancelled" && <p className="text-sm">Cancelled. Depositors can claim a refund.</p>}
      {battleId === null ? null : (
        <div className="mt-6 space-y-8">
          {phase.kind === "cancellable" && (
            <RefundStep namespace={namespace} battleId={battleId} detail={detail} name={name} cancelFirst fallback={<CancelStep namespace={namespace} battleId={battleId} />} />
          )}
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

/**
 * One button that takes back everything the connected account has in a failed battle (positions and escrow). With
 * `cancelFirst` the battle is not cancelled yet and the same approval cancels it too; an account with nothing to
 * take back sees `fallback` instead, so anyone can still cancel.
 */
function RefundStep({
  namespace, battleId, detail, name, cancelFirst = false, fallback = null,
}: { namespace: Namespace; battleId: number; detail: LifecycleDetail; name: (i: number) => string; cancelFirst?: boolean; fallback?: ReactNode }) {
  const { signIn } = useWallet();
  const refund = useRefund(namespace.arenaContract, battleId, detail.battle.communities.length, name, cancelFirst);
  const transactions = refund.txHashes?.length > 0 ? <div className="space-y-1">{refund.txHashes.map((hash, i) => <div key={hash} className="text-xs"><span>Refund transaction {i + 1}</span><TransactionLink hash={hash} /></div>)}</div> : null;
  const amount = (units: string) => formatUnits(BigInt(units), TOKEN_DECIMALS, 4);
  if (!refund.connected) {
    return (
      <Button type="button" variant="ghost" onClick={() => void signIn()}>
        Connect wallet to get your refund
      </Button>
    );
  }
  if (refund.claims === null) return <p role="status" className="text-xs text-mute">Checking what you can get back…</p>;
  if (refund.claims.length === 0 && cancelFirst && refund.state.step !== "done") return <>{fallback}</>;
  if (refund.claims.length === 0) {
    return (
      <div><p role="status" className="text-sm text-mute">
        {refund.state.step === "done" ? "Refunded. Check your wallet." : "You have nothing to refund in this battle."}
      </p>{transactions}</div>
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
      {transactions}
    </div>
  );
}
