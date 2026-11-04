"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { useArena, useWallet } from "@/components/providers";
import { useAction } from "@/hooks/use-action";
import { formatUnits, parseUnits } from "@/lib/amounts";
import type { BattleView, Side, TokenMeta } from "@/lib/arena/types";
import { cn } from "@/lib/utils";

/** Plain meme-coin deposit: `ft_transfer_call` of the chosen tribe's coin to the arena. */
export function DepositForm({
  battle,
  metaA,
  metaB,
  lockedSide,
  onDone,
}: {
  battle: BattleView;
  metaA: TokenMeta;
  metaB: TokenMeta;
  /** A wallet can only back one tribe per battle. */
  lockedSide: Side | null;
  onDone: () => void;
}) {
  const api = useArena();
  const { accountId, signIn } = useWallet();
  const [side, setSide] = useState<Side>(lockedSide ?? "A");
  const [amount, setAmount] = useState("");
  const action = useAction();
  const [ok, setOk] = useState(false);

  const activeSide = lockedSide ?? side;
  const meta = activeSide === "A" ? metaA : metaB;
  const tokenId = activeSide === "A" ? battle.token_a : battle.token_b;
  const parsed = parseUnits(amount, meta.decimals);
  const invalid = amount !== "" && (parsed === null || parsed <= 0n);

  const submit = async () => {
    if (!accountId || parsed === null || parsed <= 0n) return;
    setOk(false);
    const success = await action.run(() =>
      api.depositCoin({ signerId: accountId, battleId: battle.id, side: activeSide, tokenId, amount: parsed }),
    );
    if (success) {
      setOk(true);
      setAmount("");
      onDone();
    }
  };

  return (
    <Card>
      <CardTitle>Deposit coins</CardTitle>
      <div className="grid grid-cols-2 gap-2">
        {(["A", "B"] as const).map((s) => {
          const m = s === "A" ? metaA : metaB;
          const disabled = lockedSide !== null && lockedSide !== s;
          return (
            <button
              key={s}
              type="button"
              disabled={disabled}
              onClick={() => setSide(s)}
              aria-pressed={activeSide === s}
              className={cn(
                "border-2 px-3 py-3 font-pixel text-[10px] uppercase disabled:opacity-30",
                activeSide === s
                  ? s === "A"
                    ? "border-neon-cyan bg-neon-cyan/15 text-neon-cyan"
                    : "border-neon-pink bg-neon-pink/15 text-neon-pink"
                  : "border-edge text-mute",
              )}
            >
              Tribe {s}: {m.symbol}
            </button>
          );
        })}
      </div>
      <div className="mt-3">
        <Label htmlFor="deposit-amount">Amount ({meta.symbol})</Label>
        <Input
          id="deposit-amount"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-invalid={invalid}
        />
        {invalid && <p className="mt-1 text-lg text-neon-red">Enter a positive amount with at most {meta.decimals} decimals.</p>}
        {parsed !== null && parsed > 0n && (
          <p className="mt-1 text-lg text-mute">
            Sends {formatUnits(parsed, meta.decimals, 6)} {meta.symbol} via ft_transfer_call
          </p>
        )}
      </div>
      <div className="mt-4">
        {accountId ? (
          <Button onClick={() => void submit()} disabled={action.busy || parsed === null || parsed <= 0n}>
            {action.busy ? "Sending..." : "Deposit"}
          </Button>
        ) : (
          <Button variant="cyan" onClick={() => void signIn()}>
            Connect wallet to deposit
          </Button>
        )}
      </div>
      {action.error && <p role="alert" className="mt-2 text-lg text-neon-red">{action.error}</p>}
      {ok && <p className="mt-2 text-lg text-neon-green">Deposit sent.</p>}
    </Card>
  );
}
