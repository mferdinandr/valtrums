"use client";

import { TokenIcon } from "@/components/token-icon";
import { SkeletonGroup, TokenCardSkeleton } from "@/components/ui/skeleton";
import { useWallet } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { useFaucet } from "@/hooks/use-faucet";
import { formatUnits } from "@/lib/amounts";
import { FAUCET_DECIMALS, claimBatches, unavailableReason } from "@/lib/arena-read/faucet";

export function FaucetPanel() {
  const { signIn } = useWallet();
  const f = useFaucet();
  if (!f.contract) {
    return (
      <Card role="alert">
        The faucet is currently unavailable. Please try again later.
      </Card>
    );
  }
  const claimable = f.state?.tokens.filter((t) => t.canClaim) ?? [];
  const busy = f.claiming !== null;
  return (
    <div className="space-y-6">
      <Card className="space-y-3">
        <CardTitle>Your account</CardTitle>
        {!f.accountId ? (
          <Button type="button" variant="primary" onClick={() => void signIn()}>Connect wallet</Button>
        ) : (
          <p className="break-all text-sm">Signed in as <strong>{f.accountId}</strong></p>
        )}
        <p className="text-xs text-mute">Claims require a little testnet NEAR for gas. Your first claim of each token also requires a small deposit; unused funds are returned.</p>
        {f.state?.paused && <p role="status" className="lifecycle-callout"><strong>Paused.</strong> The faucet is not giving out tokens right now.</p>}
        {f.error && <p role="alert" className="text-xs text-neon-red">{f.error}</p>}
      </Card>

      <Card className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Test tokens</CardTitle>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => void f.refresh()} disabled={f.loading || busy}>Refresh</Button>
            <Button type="button" onClick={() => void f.claim(claimable)} disabled={!f.connected || busy || claimable.length === 0}>
              {busy ? `Claiming ${f.claiming}…` : claimable.length === 0 ? "Nothing to claim" : `Claim all (${claimable.length}) · ${claimBatches(claimable).length} approval${claimBatches(claimable).length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
        {f.loading && !f.state && (
          <SkeletonGroup label="Reading the faucet…" className="token-grid">
            {[0, 1, 2, 3, 4, 5].map((i) => <TokenCardSkeleton key={i} />)}
          </SkeletonGroup>
        )}
        {f.state && f.state.tokens.length === 0 && (
          <p role="status" className="lifecycle-callout">
            <strong>No tokens yet.</strong> The faucet contract is live, but the operator has not offered any token. Check back soon.
          </p>
        )}
        <ul className="token-grid">
          {(f.state?.tokens ?? []).map((t) => {
            const reason = unavailableReason(t, f.state?.paused ?? false);
            const outcome = f.outcomes.find((o) => o.symbol === t.symbol);
            return (
              <li key={t.token}>
                <div className="token-card">
                  <TokenIcon symbol={t.symbol} size={44} />
                  <strong>{t.symbol}</strong>
                  <span>{formatUnits(BigInt(t.amount), FAUCET_DECIMALS, 2)} per claim</span>
                  {t.canClaim ? <Badge tone="green">ready</Badge> : t.cooldownRemainingMs > 0 ? <Badge tone="amber">cooldown</Badge> : <Badge tone="mute">unavailable</Badge>}
                  <Button type="button" variant="ghost" disabled={!f.connected || busy || !t.canClaim} onClick={() => void f.claim([t])}>
                    Claim {t.symbol}
                  </Button>
                  {reason && <span className="text-xs text-mute">{reason}</span>}
                  {outcome && <span role={outcome.ok ? "status" : "alert"} className="text-xs">{outcome.message}</span>}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-mute">
          These are testnet tokens with no real-world value.
        </p>
      </Card>
    </div>
  );
}
