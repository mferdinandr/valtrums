"use client";

import { Wallet } from "lucide-react";
import { useMemo } from "react";
import { PayoutRequest } from "@/components/payout-request";
import { TokenIcon } from "@/components/token-icon";
import { Button } from "@/components/ui/button";
import { useAction } from "@/hooks/use-action";
import { useActionRunner } from "@/hooks/use-action-runner";
import { useDeploymentFacts, usePortfolio } from "@/hooks/use-portfolio";
import { formatUnits } from "@/lib/amounts";
import { applicationKey, type Namespace } from "@/lib/arena-read/application";
import { TOKEN_DECIMALS } from "@/lib/arena-read/balances";
import { buildClaimReview, buildRegisterReview, claimRequest, readRegistered, registerRequest } from "@/lib/arena-read/claim";
import { describePayouts, type Entitlement } from "@/lib/arena-read/portfolio";
import { config } from "@/lib/config";

/** The token symbol of a representation account such as `wallet.rep.testnet`, for display only. */
const symbolOf = (backing: string): string => (backing.split(".")[0] ?? backing).toUpperCase();

/**
 * Prize claim on the battle page. The default claim mints the representation tokens into the connected NEAR
 * account, 1:1 with the custody on the source chain. The Robinhood payout from the Portfolio stays available
 * under "Send to Robinhood Chain instead". Reading the entitlement needs one wallet signature (NEP-413).
 */
export function BattleClaim({ namespace }: { namespace: Namespace }) {
  const portfolio = usePortfolio();
  const facts = useDeploymentFacts(namespace);
  const { act, accountId, connected } = useActionRunner();
  const action = useAction();
  const ready = portfolio.state.step === "ready" ? portfolio.state.data : null;
  const entitlements = useMemo<Entitlement[] | null>(
    () => (ready?.accountState.state === "ok" ? ready.accountState.env.data.entitlements.map((e) => ({ backing: e.backing, available: e.available })) : null),
    [ready],
  );
  const payouts = useMemo(() => (ready?.payouts.state === "ok" ? describePayouts(ready.payouts.env.data.payouts) : null), [ready]);
  const busy = portfolio.state.step === "opening-session" || portfolio.state.step === "reading";
  const claimable = (entitlements ?? []).filter((e) => /^[0-9]+$/.test(e.available) && BigInt(e.available) > 0n);

  const claim = (e: Entitlement) =>
    action.run(async () => {
      if (!accountId) throw new Error("connect a wallet first");
      const label = symbolOf(e.backing);
      if (!(await readRegistered(config.rpcUrl, e.backing, accountId))) {
        const register = buildRegisterReview(e.backing, accountId, label);
        await act(registerRequest(e.backing), register.ok ? register : null);
      }
      const review = buildClaimReview(e.backing, e.available, label);
      await act(claimRequest(e.backing, e.available), review.ok ? review : null);
      await portfolio.load();
    });

  return (
    <div className="mt-4 space-y-3">
      {!ready ? (
        <Button type="button" className="w-full" onClick={() => void portfolio.load()} disabled={busy || !portfolio.connected}>
          {busy ? "Checking your prize…" : "Check my prize"}
        </Button>
      ) : (
        <>
          {claimable.length === 0 && entitlements !== null && (
            <p className="text-sm text-mute">No prize to claim yet. It appears here after the battle is settled.</p>
          )}
          {claimable.map((e) => (
            <div key={e.backing} className="flex items-center justify-between gap-3 rounded-xl p-3" style={{ background: "#fffdf6", border: "1px solid #d8dfd3" }}>
              <div className="flex min-w-0 items-center gap-3">
                <TokenIcon symbol={symbolOf(e.backing)} size={36} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold tabular-nums">{formatUnits(BigInt(e.available), TOKEN_DECIMALS, 4)} {symbolOf(e.backing)}</p>
                  <p className="text-xs text-mute">1:1 with the source custody</p>
                </div>
              </div>
              <Button type="button" disabled={action.busy || !connected} onClick={() => void claim(e)}>
                <Wallet size={16} aria-hidden="true" /> {action.busy ? "Claiming…" : "Claim to NEAR wallet"}
              </Button>
            </div>
          ))}
          {action.error && <p role="alert" className="text-xs text-neon-red">{action.error}</p>}
          <details className="lifecycle-tech">
            <summary>Send to Robinhood Chain instead</summary>
            <p className="my-2 text-xs text-mute">
              This redeems the token to the source chain: it is paid to the 0x address you enter, once the transfer is confirmed.
            </p>
            <PayoutRequest
              deploymentId={namespace.deploymentId}
              namespaceKey={applicationKey(namespace)}
              facts={facts}
              entitlements={entitlements}
              payouts={payouts}
              onChanged={() => void portfolio.load()}
            />
          </details>
        </>
      )}
      {portfolio.state.step === "error" && <p role="alert" className="text-xs text-neon-red">{portfolio.state.message}</p>}
    </div>
  );
}
