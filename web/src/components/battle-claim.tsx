"use client";

import { PayoutRequest } from "@/components/payout-request";
import { Button } from "@/components/ui/button";
import { useDeploymentFacts, usePortfolio } from "@/hooks/use-portfolio";
import { applicationKey, type Namespace } from "@/lib/arena-read/application";
import { describePayouts, type Entitlement } from "@/lib/arena-read/portfolio";
import { useMemo } from "react";

/**
 * Prize claim on the battle page. It is the Portfolio's reviewed payout request, not a second implementation:
 * the same gate, request id, preview comparison and wallet signature apply. Reading the entitlement needs one
 * wallet signature (NEP-413), so it starts from a button.
 */
export function BattleClaim({ namespace }: { namespace: Namespace }) {
  const portfolio = usePortfolio();
  const facts = useDeploymentFacts(namespace);
  const ready = portfolio.state.step === "ready" ? portfolio.state.data : null;
  const entitlements = useMemo<Entitlement[] | null>(
    () => (ready?.accountState.state === "ok" ? ready.accountState.env.data.entitlements.map((e) => ({ backing: e.backing, available: e.available })) : null),
    [ready],
  );
  const payouts = useMemo(() => (ready?.payouts.state === "ok" ? describePayouts(ready.payouts.env.data.payouts) : null), [ready]);
  const busy = portfolio.state.step === "opening-session" || portfolio.state.step === "reading";

  return (
    <div className="mt-3 space-y-3">
      <p className="text-xs text-mute">
        Your prize is the losing token itself, paid on Robinhood Chain to the 0x address you enter. Your NEAR wallet only signs the
        request; the tokens arrive at that address once the transfer is confirmed.
      </p>
      {!ready ? (
        <Button type="button" onClick={() => void portfolio.load()} disabled={busy || !portfolio.connected}>
          {busy ? "Checking your prize…" : "Check my prize"}
        </Button>
      ) : (
        <>
          {entitlements !== null && entitlements.length === 0 && (
            <p className="text-sm">No prize is recorded for you yet. It appears after the battle is settled.</p>
          )}
          <PayoutRequest
            deploymentId={namespace.deploymentId}
            namespaceKey={applicationKey(namespace)}
            facts={facts}
            entitlements={entitlements}
            payouts={payouts}
            onChanged={() => void portfolio.load()}
          />
        </>
      )}
      {portfolio.state.step === "error" && <p role="alert" className="text-xs text-neon-red">{portfolio.state.message}</p>}
    </div>
  );
}
