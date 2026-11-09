"use client";

import { useEffect, useState } from "react";
import type { DepositPhase } from "@/components/kinetic/battle-state";
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
  selectedSide,
  onSelectSide,
  onVisualChange,
  disabled = false,
}: {
  battle: BattleView;
  metaA: TokenMeta;
  metaB: TokenMeta;
  /** A wallet can only back one tribe per battle. */
  lockedSide: Side | null;
  onDone: () => void;
  selectedSide?: Side;
  onSelectSide?: (side: Side) => void;
  onVisualChange?: (phase: DepositPhase) => void;
  disabled?: boolean;
}) {
  const api = useArena();
  const { accountId, signIn } = useWallet();
  const [side, setSide] = useState<Side>(lockedSide ?? "A");
  const [amount, setAmount] = useState("");
  const action = useAction();
  const [ok, setOk] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [review, setReview] = useState(false);

  const activeSide = lockedSide ?? selectedSide ?? side;
  const meta = activeSide === "A" ? metaA : metaB;
  const tokenId = activeSide === "A" ? battle.token_a : battle.token_b;
  const parsed = parseUnits(amount, meta.decimals);
  const invalid = amount !== "" && (parsed === null || parsed <= 0n);
  const phase: DepositPhase = action.busy
    ? "pending"
    : ok
      ? "success"
      : submitted
        ? "submitted"
        : action.error
          ? "error"
          : review
            ? "review"
            : parsed !== null && parsed > 0n
              ? "preview"
              : "idle";
  useEffect(() => {
    onVisualChange?.(phase);
  }, [phase, onVisualChange]);
  useEffect(() => {
    setReview(false);
  }, [activeSide]);

  const submit = async () => {
    if (
      !accountId ||
      parsed === null ||
      parsed <= 0n ||
      disabled ||
      action.busy
    )
      return;
    setOk(false);
    setSubmitted(false);
    let previous: bigint | null = null;
    let credited = false;
    const success = await action.run(() =>
      (async () => {
        try {
          const position = await api.getPosition(battle.id, accountId);
          previous = BigInt(position?.coin_amount ?? "0");
        } catch {
          /* A failed read never establishes credited funds. */
        }
        await api.depositCoin({
          signerId: accountId,
          battleId: battle.id,
          side: activeSide,
          tokenId,
          amount: parsed,
        });
        try {
          const position = await api.getPosition(battle.id, accountId);
          credited =
            previous !== null &&
            position?.side === activeSide &&
            BigInt(position.coin_amount) >= previous + parsed;
        } catch {
          /* Preserve submitted status while the view is unavailable. */
        }
      })(),
    );
    if (success) {
      setOk(credited);
      setSubmitted(!credited);
      setAmount("");
      setReview(false);
      onDone();
    }
  };

  return (
    <Card>
      <CardTitle>Deposit coins</CardTitle>
      <div className="grid grid-cols-2 gap-2">
        {(["A", "B"] as const).map((s) => {
          const m = s === "A" ? metaA : metaB;
          const sideDisabled =
            disabled ||
            action.busy ||
            review ||
            (lockedSide !== null && lockedSide !== s);
          return (
            <button
              key={s}
              type="button"
              disabled={sideDisabled}
              onClick={() => {
                setSide(s);
                onSelectSide?.(s);
                setOk(false);
                setSubmitted(false);
                action.clearError();
              }}
              aria-pressed={activeSide === s}
              className={cn(
                "rounded-lg border px-3 py-3 font-pixel text-[11px] uppercase disabled:opacity-40",
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
          onChange={(e) => {
            setAmount(e.target.value);
            setOk(false);
            setSubmitted(false);
            action.clearError();
          }}
          disabled={disabled || action.busy || review}
          aria-invalid={invalid}
        />
        {invalid && (
          <p className="mt-1 text-lg text-neon-red">
            Enter a positive amount with at most {meta.decimals} decimals.
          </p>
        )}
        {parsed !== null && parsed > 0n && (
          <p className="mt-1 text-lg text-mute">
            Sends {formatUnits(parsed, meta.decimals, 6)} {meta.symbol} via
            ft_transfer_call
          </p>
        )}
      </div>
      <div className="mt-4">
        {accountId ? (
          review ? (
            <div className="space-y-3 rounded-lg border border-neon-amber/40 bg-neon-amber/5 p-4">
              <p className="text-sm text-neon-amber">
                Review: {amount} {meta.symbol} → battle #{battle.id}, tribe{" "}
                {activeSide}
              </p>
              <p className="text-xs text-mute">
                The animation is a preview. Your wallet authorizes the transfer.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => void submit()}
                  disabled={disabled || action.busy}
                >
                  {action.busy ? "Waiting for transaction…" : "Confirm deposit"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={action.busy}
                  onClick={() => setReview(false)}
                >
                  Edit deposit
                </Button>
              </div>
            </div>
          ) : (
            <Button
              onClick={() => setReview(true)}
              disabled={
                disabled || action.busy || parsed === null || parsed <= 0n
              }
            >
              Review deposit
            </Button>
          )
        ) : (
          <Button variant="cyan" onClick={() => void signIn()}>
            Connect wallet to deposit
          </Button>
        )}
      </div>
      {action.error && (
        <p role="alert" className="mt-2 text-lg text-neon-red">
          {action.error}
        </p>
      )}
      {ok && <p className="mt-2 text-lg text-neon-green">Deposit sent.</p>}
      {submitted && (
        <p role="status" className="mt-2 text-sm text-neon-amber">
          Deposit submitted. Credit is not verified yet; inspect your position
          before retrying.
        </p>
      )}
    </Card>
  );
}
