"use client";

import { Card, CardTitle } from "@/components/ui/card";
import { HpBar } from "@/components/hp-bar";
import { Countdown } from "@/components/countdown";
import { useNow } from "@/hooks/use-now";
import { CREDIT_TTL_NS, formatUsdc, msUntilNs, nsToMs, toBigInt } from "@/lib/amounts";
import type { AccountView } from "@/lib/arena/types";

/** Locked USDC credit with its 7-day expiry. */
export function CreditPanel({ account }: { account: AccountView }) {
  const now = useNow(1000);
  const credit = toBigInt(account.credit_balance);
  const expiresNs = toBigInt(account.credit_expires_at_ns);
  const remainingMs = now === 0 ? 0 : msUntilNs(expiresNs, now);
  const hasCredit = credit > 0n && expiresNs > 0n;
  const expired = hasCredit && now > 0 && remainingMs <= 0;
  const soon = hasCredit && !expired && remainingMs < 24 * 3_600_000;
  const percent = (remainingMs / nsToMs(CREDIT_TTL_NS)) * 100;

  return (
    <Card className={expired ? "border-neon-red" : soon ? "border-neon-amber" : undefined}>
      <CardTitle>Locked credit</CardTitle>
      <p className="text-4xl text-neon-cyan">{formatUsdc(expired ? 0n : credit)}</p>
      {!hasCredit ? (
        <p className="mt-2 text-xl text-mute">No credit. Winning profit grants credit that is spent first on your next deposit.</p>
      ) : expired ? (
        <p role="alert" className="mt-2 text-xl text-neon-red">
          Expired: {formatUsdc(credit)} of credit is no longer usable.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          <HpBar
            label="Time left"
            percent={percent}
            tone={soon ? "red" : "cyan"}
            right={undefined}
          />
          <p className={`text-2xl ${soon ? "text-neon-amber" : "text-ink"}`}>
            Expires in <Countdown targetNs={expiresNs} />
          </p>
          <p className="text-lg text-mute">
            Credit lasts 7 days from the last grant and is spent before wallet funds on deposits.
          </p>
        </div>
      )}
    </Card>
  );
}
