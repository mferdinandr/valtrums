"use client";

import Link from "next/link";
import { useMemo } from "react";
import { AccountStatePanel } from "@/components/account-state-panel";
import { PayoutRequest } from "@/components/payout-request";
import { PortfolioView } from "@/components/portfolio-view";
import {
  EntitlementAvailabilitySection,
  LateFundsSection,
  PositionsSection,
  TransfersSection,
} from "@/components/portfolio-sections";
import { useApplicationDeployment, useWallet } from "@/components/providers";
import { RecoveryAlerts } from "@/components/recovery-alerts";
import { CarnivalScene } from "@/components/carnival/scene";
import "@/components/lifecycle/lifecycle.css";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useNow } from "@/hooks/use-now";
import { useDeploymentFacts, usePortfolio } from "@/hooks/use-portfolio";
import { applicationKey } from "@/lib/arena-read/application";
import { describePayouts, type Entitlement } from "@/lib/arena-read/portfolio";

/**
 * Portfolio of the connected account on the lifecycle deployment. Positions, entitlements, transfers, late funds,
 * DAO principal and alerts are separate sections with their source and freshness. Account reads need one wallet
 * signature (NEP-413); the session token stays in memory. Nothing on this page is legacy A/B data.
 */
export default function PortfolioPage() {
  const namespace = useApplicationDeployment();
  const { signIn } = useWallet();
  const portfolio = usePortfolio();
  const facts = useDeploymentFacts(namespace);
  const now = useNow(30_000);

  const ready = portfolio.state.step === "ready" ? portfolio.state.data : null;
  const entitlements = useMemo<Entitlement[] | null>(
    () => (ready?.accountState.state === "ok" ? ready.accountState.env.data.entitlements.map((e) => ({ backing: e.backing, available: e.available })) : null),
    [ready],
  );
  const payoutRows = useMemo(() => (ready?.payouts.state === "ok" ? describePayouts(ready.payouts.env.data.payouts) : null), [ready]);

  if (!namespace) {
    return (
      <Card role="alert" className="m-4 space-y-2 p-4">
        <p>Your portfolio is currently unavailable. Please try again later.</p>
        <Link href="/arena" className="underline">
          Browse battles
        </Link>
      </Card>
    );
  }

  const busy = portfolio.state.step === "opening-session" || portfolio.state.step === "reading";
  return (
    <div className="lifecycle-page">
      <header className="arcade-heading arcade-heading--portfolio">
        <div>
          <span className="arcade-kicker">YOUR PORTFOLIO</span>
          <h1>Your battles, all in one place.</h1>
          <p>Follow your positions and see what’s ready to claim.</p>
        </div>
        <CarnivalScene mode="portfolio" caption="Your keepsake cabinet" />
      </header>

      {!portfolio.accountId ? (
        <Card className="space-y-2 p-4">
          <p className="text-base">Connect your wallet to see your positions and rewards.</p>
          <Button type="button" variant="ghost" onClick={() => void signIn()}>
            Connect wallet
          </Button>
        </Card>
      ) : (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="text-xs text-mute">Connected account</p>
            <p className="truncate text-base font-semibold">{portfolio.accountId}</p>
            {portfolio.state.step !== "ready" && (
              <p className="text-xs text-mute">Sign once to view your portfolio. This read-only request cannot move your funds.</p>
            )}
          </div>
          <Button type="button" onClick={() => void portfolio.load()} disabled={busy || !portfolio.connected}>
            {busy ? "Loading…" : portfolio.state.step === "ready" ? "Refresh" : "Sign and view portfolio"}
          </Button>
          {portfolio.state.step === "error" && (
            <p role="alert" className="w-full text-sm text-neon-amber">
              {portfolio.state.message}. Nothing was loaded.
            </p>
          )}
        </Card>
      )}

      {ready && <PortfolioView data={ready} onChanged={() => void portfolio.load()} />}

      <RecoveryAlerts />

      {ready && (
        <details className="lifecycle-tech">
          <summary>Details, sources and limitations</summary>
          <div className="mt-3 space-y-4">
            <PositionsSection part={ready.positions} nowMs={now} />
            <EntitlementAvailabilitySection part={ready.entitlements} nowMs={now} />
            <AccountStatePanel part={ready.accountState} nowMs={now} />
            <TransfersSection part={ready.payouts} nowMs={now} />
            <LateFundsSection />
          </div>
        </details>
      )}

      <details className="lifecycle-tech">
        <summary>Advanced: send a claim to Robinhood Chain instead</summary>
        <div className="mt-3">
          <PayoutRequest
            deploymentId={namespace.deploymentId}
            namespaceKey={applicationKey(namespace)}
            facts={facts}
            entitlements={entitlements}
            payouts={payoutRows}
            onChanged={() => void portfolio.load()}
          />
        </div>
      </details>
    </div>
  );
}
