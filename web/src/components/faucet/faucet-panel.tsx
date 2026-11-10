"use client";

import { TokenIcon } from "@/components/token-icon";
import { useWallet } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { useFaucet } from "@/hooks/use-faucet";
import { formatUnits } from "@/lib/amounts";
import { claimMessage, formatWait } from "@/lib/arena-read/faucet";

/** The representations have 18 decimals, like the mock tokens they are backed by. */
const DECIMALS = 18;

export function FaucetPanel() {
  const { signIn } = useWallet();
  const f = useFaucet();
  const claimable = f.status?.tokens.filter((t) => t.cooldownRemainingMs === 0 && t.available) ?? [];
  return (
    <div className="space-y-6">
      <Card className="space-y-3">
        <CardTitle>01 / Your account</CardTitle>
        {!f.accountId ? (
          <Button type="button" variant="primary" onClick={() => void signIn()}>Connect wallet</Button>
        ) : (
          <p className="break-all text-sm">Signed in as <strong>{f.accountId}</strong></p>
        )}
        {f.accountId && !f.status && (
          <Button type="button" onClick={() => void f.refresh()} disabled={!f.connected || f.loading}>
            {f.loading ? "Waiting for the wallet…" : "Check the faucet"}
          </Button>
        )}
        <p className="text-xs text-mute">
          Checking asks your wallet to sign a message that only proves who you are. It grants no spending authority. You
          also need a little testnet NEAR for gas; get it from a public NEAR testnet faucet.
        </p>
        {f.status && !f.status.live && (
          <p role="status" className="lifecycle-callout">
            <strong>Dry run.</strong> This faucet is not live yet, so claiming only shows what would be sent.
          </p>
        )}
        {f.error && <p role="alert" className="text-xs text-neon-red">{f.error}</p>}
      </Card>

      {f.status && (
        <Card className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>02 / Test tokens</CardTitle>
            <Button type="button" onClick={() => void f.claim()} disabled={f.claiming || claimable.length === 0}>
              {f.claiming ? "Claiming…" : claimable.length === 0 ? "Nothing to claim" : `Claim all (${claimable.length})`}
            </Button>
          </div>
          <ul className="token-grid">
            {f.status.tokens.map((t) => {
              const result = f.results?.find((r) => r.symbol === t.symbol);
              const wait = formatWait(t.cooldownRemainingMs);
              return (
                <li key={t.symbol}>
                  <div className="token-card">
                    <TokenIcon symbol={t.symbol} size={44} />
                    <strong>{t.symbol}</strong>
                    <span>{formatUnits(BigInt(t.amount), DECIMALS, 2)} per claim</span>
                    {t.cooldownRemainingMs > 0 ? <Badge tone="amber">next in {wait}</Badge> : !t.available ? <Badge tone="mute">empty</Badge> : <Badge tone="green">ready</Badge>}
                    <Button type="button" variant="ghost" disabled={f.claiming || t.cooldownRemainingMs > 0 || !t.available} onClick={() => void f.claim([t.symbol])}>
                      Claim {t.symbol}
                    </Button>
                    {result && <span role="status" className="text-xs">{claimMessage(result)}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-mute">
            Testnet tokens with no value. Each is a NEAR representation backed 1:1 by tokens deposited on Robinhood
            testnet, so receiving one does not mint anything new. After claiming, register a position in a battle and
            deposit from the battle page.
          </p>
        </Card>
      )}
    </div>
  );
}
