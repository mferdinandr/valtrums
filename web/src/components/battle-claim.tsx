"use client";

import { Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { TokenIcon } from "@/components/token-icon";
import { Button } from "@/components/ui/button";
import { useAction } from "@/hooks/use-action";
import { useActionRunner } from "@/hooks/use-action-runner";
import { formatUnits } from "@/lib/amounts";
import { TOKEN_DECIMALS } from "@/lib/arena-read/balances";
import {
  buildClaimReview,
  buildRegisterReview,
  buildSettleReview,
  claimRequest,
  readEntitlement,
  readRegistered,
  readSettlement,
  registerRequest,
  settleBatch,
  settleRequest,
  type SettlementProgress,
} from "@/lib/arena-read/claim";
import { daoStep, readDisposition } from "@/lib/arena-read/dao";
import { config } from "@/lib/config";

const POLL_MS = 5_000;

/** The token symbol of a representation account such as `backing-cashcat.<owner>.testnet`, for display only. */
const symbolOf = (backing: string): string => ((backing.split(".")[0] ?? backing).replace(/^backing-/, "")).toUpperCase();

interface Row {
  backing: string;
  available: string;
}

/**
 * Prize claim on the battle page, into the connected NEAR account as representation tokens, 1:1 with the custody
 * on the source chain. It opens only once the DAO decision is finished (or there is no DAO outcome to wait for).
 * Entitlements are read from the backing contracts directly, so no wallet signature is needed to see them.
 */
export function BattleClaim({ arena, battleId, backings, winnerBacking }: { arena: string; battleId: number; backings: readonly string[]; winnerBacking: string }) {
  const { act, accountId, connected } = useActionRunner();
  const action = useAction();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [step, setStep] = useState<ReturnType<typeof daoStep> | null>(null);
  const [progress, setProgress] = useState<SettlementProgress | null>(null);
  const [step2, setStep2] = useState<{ done: number; total: number } | null>(null);
  const key = backings.join(",");

  const refresh = useCallback(async () => {
    if (!accountId) return;
    const [disposition, settlement, found] = await Promise.all([
      readDisposition(config.rpcUrl, arena, battleId),
      readSettlement(config.rpcUrl, arena, battleId),
      Promise.all(backings.map(async (backing) => ({ backing, available: await readEntitlement(config.rpcUrl, backing, accountId) }))),
    ]);
    setStep(daoStep(disposition));
    setProgress(settlement);
    setRows(found.filter((r) => BigInt(r.available) > 0n));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, arena, battleId, key]);

  useEffect(() => {
    const tick = () => void refresh().catch(() => undefined);
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // One click claims everything owed, token by token: each one registers the account first when needed. A failure
  // stops the run and the next click continues from what is still owed, so nothing is claimed twice.
  const claimAll = () =>
    action.run(async () => {
      if (!accountId || !rows) throw new Error("connect a wallet first");
      const todo = rows;
      try {
        for (const [i, r] of todo.entries()) {
          setStep2({ done: i, total: todo.length });
          const label = symbolOf(r.backing);
          if (!(await readRegistered(config.rpcUrl, r.backing, accountId))) {
            const register = buildRegisterReview(r.backing, accountId, label);
            await act(registerRequest(r.backing), register.ok ? register : null);
          }
          // What is owed right now, not what the page showed a moment ago.
          const available = await readEntitlement(config.rpcUrl, r.backing, accountId);
          if (BigInt(available) === 0n) continue;
          const review = buildClaimReview(r.backing, available, label);
          await act(claimRequest(r.backing, available), review.ok ? review : null);
        }
      } finally {
        setStep2(null);
        await refresh().catch(() => undefined);
      }
    });

  const settle = () =>
    action.run(async () => {
      if (!progress) return;
      const review = buildSettleReview(arena, battleId, progress);
      await act(settleRequest(battleId), review.ok ? review : null);
      await refresh();
    });

  // The claim opens when the DAO is done, never decided, or the battle has no vote at all.
  const open = step !== null && (step.kind === "done" || step.kind === "undecided" || step.kind === "none");
  if (step === null || rows === null) return null;
  const unsettled = progress !== null && progress.recorded < progress.total;
  if (unsettled) {
    const batch = settleBatch(progress);
    return (
      <div className="mt-4 space-y-2 rounded-xl p-3" style={{ background: "#a8802f14" }}>
        <p className="text-sm font-semibold" style={{ color: "#a8802f" }}>Prizes are not settled yet</p>
        <p className="text-xs text-mute">
          {progress.recorded} of {progress.total} recorded. The coins of the losing communities reach you only after this step; anyone can run it.
        </p>
        <Button type="button" disabled={action.busy || !connected} onClick={() => void settle()}>
          {action.busy ? "Settling…" : `Settle prizes (${batch} of ${progress.total - progress.recorded})`}
        </Button>
        {action.error && <p role="alert" className="text-xs text-neon-red">{action.error}</p>}
      </div>
    );
  }
  if (!open) return <p className="mt-4 text-sm text-mute">Claiming opens after the DAO decision.</p>;
  if (rows.length === 0) return <p className="mt-4 text-sm text-mute">No prize to claim yet. It appears here after the battle is settled.</p>;

  const kindOf = (backing: string) => (backing === winnerBacking ? "Your coins that were not burned" : "Prize from the losing community");
  return (
    <div className="mt-4 space-y-3">
      {rows.map((r) => (
        <div key={r.backing} className="flex items-center gap-3 rounded-xl p-3" style={{ background: "#fffdf6", border: "1px solid #d8dfd3" }}>
          <TokenIcon symbol={symbolOf(r.backing)} size={36} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tabular-nums">{formatUnits(BigInt(r.available), TOKEN_DECIMALS, 4)} {symbolOf(r.backing)}</p>
            <p className="text-xs text-mute">{kindOf(r.backing)}</p>
          </div>
        </div>
      ))}
      <Button type="button" className="w-full" disabled={action.busy || !connected} onClick={() => void claimAll()}>
        <Wallet size={16} aria-hidden="true" />{" "}
        {step2 ? `Claiming ${step2.done + 1} of ${step2.total}…` : rows.length > 1 ? "Claim all to my NEAR wallet" : "Claim to my NEAR wallet"}
      </Button>
      {step2 && <p role="status" className="text-xs text-mute">Confirm each step in your wallet.</p>}
      {action.error && <p role="alert" className="text-xs text-neon-red">{action.error} Press the button to continue.</p>}
    </div>
  );
}
