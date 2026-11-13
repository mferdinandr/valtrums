"use client";

import Link from "next/link";
import { useEffect } from "react";
import { PortfolioView } from "@/components/portfolio-view";
import { useApplicationDeployment, useWallet } from "@/components/providers";
import { RecoveryAlerts } from "@/components/recovery-alerts";
import { CarnivalScene } from "@/components/carnival/scene";
import "@/components/lifecycle/lifecycle.css";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import { usePortfolio } from "@/hooks/use-portfolio";

/**
 * Portfolio of the connected account on the lifecycle deployment. Positions, entitlements, transfers, late funds,
 * DAO principal and alerts are separate sections with their source and freshness. Account reads need one wallet
 * signature (NEP-413), requested automatically when the page opens; the session token stays in memory. Nothing on this page is legacy A/B data.
 */
export default function PortfolioPage() {
  const namespace = useApplicationDeployment();
  const { signIn } = useWallet();
  const portfolio = usePortfolio();

  const ready = portfolio.state.step === "ready" ? portfolio.state.data : null;

  // Load as soon as the wallet is connected. Only the idle step triggers it, so an error does not retry in a loop.
  const { state, connected, load } = portfolio;
  const hasNamespace = !!namespace;
  useEffect(() => {
    if (hasNamespace && connected && state.step === "idle") void load();
  }, [hasNamespace, connected, state.step, load]);

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
            {busy && <p className="text-xs text-mute">Approve the read-only signature in your wallet. It cannot move your funds.</p>}
          </div>
          {(ready || portfolio.state.step === "error") && (
            <Button type="button" onClick={() => void portfolio.load()} disabled={busy || !portfolio.connected}>
              {ready ? "Refresh" : "Try again"}
            </Button>
          )}
          {portfolio.state.step === "error" && (
            <p role="alert" className="w-full text-sm text-neon-amber">
              {portfolio.state.message}. Nothing was loaded.
            </p>
          )}
        </Card>
      )}

      {busy && !ready && (
        <SkeletonGroup label="Loading your portfolio" className="space-y-3">
          <Card className="space-y-3 p-4">
            <Skeleton style={{ width: 160, height: 18 }} />
            <Skeleton style={{ width: "100%", height: 56, borderRadius: 8 }} />
            <Skeleton style={{ width: "100%", height: 56, borderRadius: 8 }} />
          </Card>
        </SkeletonGroup>
      )}

      {ready && <PortfolioView data={ready} arena={namespace.arenaContract} onChanged={() => void portfolio.load()} />}

      <RecoveryAlerts />
    </div>
  );
}
