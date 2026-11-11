"use client";

import Link from "next/link";
import { useMemo } from "react";
import { AccountStatePanel } from "@/components/account-state-panel";
import { PayoutRequest } from "@/components/payout-request";
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
      <header className="lifecycle-hero">
        <div>
          <span className="lifecycle-pill">YOUR COMMUNITY KEEPSAKES</span>
          <h1>Your journey.<br />Every receipt.</h1>
          <p>Follow your positions, review your entitlements and keep track of every transfer. Your wallet holds the keys.</p>
        </div>
        <CarnivalScene mode="portfolio" caption="Your keepsake cabinet" />
      </header>

      {!portfolio.accountId ? (
        <Card className="space-y-2 p-4">
          <p className="text-base">Connect a wallet to read your positions, entitlements, transfers and principal.</p>
          <Button type="button" variant="ghost" onClick={() => void signIn()}>
            Connect wallet
          </Button>
        </Card>
      ) : (
        <Card className="space-y-2 p-4">
          <p className="break-all text-base">Account {portfolio.accountId}</p>
          <p className="text-sm text-mute">
            Reading your account needs one wallet signature that opens a read-only session. It cannot sign or spend, it is kept in memory only and is
            dropped on sign-out or when you switch accounts.
          </p>
          <Button type="button" onClick={() => void portfolio.load()} disabled={busy || !portfolio.connected}>
            {busy ? "Loading…" : portfolio.state.step === "ready" ? "Refresh portfolio" : "Sign and view portfolio"}
          </Button>
          {portfolio.state.step === "error" && (
            <p role="alert" className="text-base text-neon-amber">
              {portfolio.state.message}. Nothing was loaded.
            </p>
          )}
        </Card>
      )}

      {ready && (
        <>
          <PositionsSection part={ready.positions} nowMs={now} />
          <EntitlementAvailabilitySection part={ready.entitlements} nowMs={now} />
          <AccountStatePanel part={ready.accountState} nowMs={now} />
          <TransfersSection part={ready.payouts} nowMs={now} />
          <LateFundsSection />
        </>
      )}

      <RecoveryAlerts />

      <PayoutRequest
        deploymentId={namespace.deploymentId}
        namespaceKey={applicationKey(namespace)}
        facts={facts}
        entitlements={entitlements}
        payouts={payoutRows}
        onChanged={() => void portfolio.load()}
      />
    </div>
  );
}
