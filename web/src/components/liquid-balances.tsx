"use client";

import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { formatUnits } from "@/lib/amounts";
import type { TokenMeta } from "@/lib/arena/types";

export interface LiquidRow {
  meta: TokenMeta;
  balance: bigint;
}

/** Per-token liquid balances with a withdraw button each. Zero balances are hidden except USDC. */
export function LiquidBalances({
  rows,
  usdcId,
  busyToken,
  error,
  onWithdraw,
}: {
  rows: LiquidRow[];
  usdcId: string;
  busyToken: string | null;
  error: string | null;
  onWithdraw: (row: LiquidRow) => void;
}) {
  const shown = rows.filter((r) => r.balance > 0n || r.meta.id === usdcId);
  return (
    <Card id="balances">
      <CardTitle>Liquid balances</CardTitle>
      <p className="mb-3 text-lg text-mute">
        Claimed and refunded funds wait here, per token. Withdraw sends them to your wallet (1 yoctoNEAR, wallet approval).
      </p>
      <ul className="space-y-2">
        {shown.map((r) => (
          <li key={r.meta.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-2xl text-neon-green">
              {formatUnits(r.balance, r.meta.decimals, 4)} {r.meta.symbol}
            </span>
            <Button
              size="sm"
              variant="cyan"
              disabled={busyToken !== null || r.balance === 0n}
              onClick={() => onWithdraw(r)}
              aria-label={`Withdraw ${r.meta.symbol}`}
            >
              {busyToken === r.meta.id ? "Withdrawing..." : "Withdraw"}
            </Button>
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="mt-2 text-lg text-neon-red">{error}</p>}
    </Card>
  );
}
