"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { useArena, useWallet } from "@/components/providers";
import { useAction } from "@/hooks/use-action";
import { formatUsdc, formatUnits, USDC_DECIMALS } from "@/lib/amounts";
import { checkFundAmount } from "@/lib/arena/balance";

/**
 * Moves wallet USDC into the arena's internal balance. One wallet approval; later deposits from this balance
 * need none while a session key is valid. Shown on the portfolio and inside the terminal when the balance is short.
 */
export function FundBalance({
  walletUsdc,
  balance,
  suggested,
  onFunded,
  embedded = false,
}: {
  /** USDC in the NEAR wallet (base units). */
  walletUsdc: bigint;
  /** USDC in the arena's internal balance (base units). */
  balance: bigint;
  /** Pre-fills the amount (for example the shortfall of a deposit). */
  suggested?: bigint;
  onFunded: () => void;
  embedded?: boolean;
}) {
  const api = useArena();
  const { accountId } = useWallet();
  const action = useAction();
  const [text, setText] = useState(suggested && suggested > 0n ? formatUnits(suggested, USDC_DECIMALS, USDC_DECIMALS) : "");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!accountId) return;
    const check = checkFundAmount(text, walletUsdc);
    if (!check.ok) return setLocalError(check.error);
    setLocalError(null);
    const ok = await action.run(() => api.fundBalance({ signerId: accountId, amount: check.units }));
    if (ok) {
      setText("");
      onFunded();
    }
  };

  const body = (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-2 text-xl">
        <div>
          <dt className="text-mute">Wallet USDC</dt>
          <dd className="text-neon-cyan">{formatUsdc(walletUsdc)}</dd>
        </div>
        <div>
          <dt className="text-mute">Arena balance</dt>
          <dd className="text-neon-green">{formatUsdc(balance)}</dd>
        </div>
      </dl>
      <p className="text-lg text-mute">
        The balance is held by the arena contract, not by this site. You can withdraw it any time with <span className="text-ink">withdraw_liquid</span>.
        It is what a session key can spend on deposits, and nothing more.
      </p>
      <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-2">
        <div className="min-w-32 flex-1">
          <Label htmlFor={embedded ? "fund-amount-inline" : "fund-amount"}>Amount (USDC)</Label>
          <Input
            id={embedded ? "fund-amount-inline" : "fund-amount"}
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="25"
            autoComplete="off"
          />
        </div>
        <Button type="submit" variant="cyan" disabled={action.busy || text.trim() === ""}>
          {action.busy ? "Waiting for wallet..." : "Fund balance"}
        </Button>
      </form>
      <p className="text-base text-mute">One wallet approval (1 yoctoNEAR, full access). Later deposits from the balance need no approval while a session key is valid.</p>
      {(localError || action.error) && (
        <p role="alert" className="text-lg text-neon-red">
          {localError ?? action.error}
        </p>
      )}
    </div>
  );

  if (embedded) return body;
  return (
    <Card id="fund-balance">
      <CardTitle>Fund balance</CardTitle>
      {body}
    </Card>
  );
}
