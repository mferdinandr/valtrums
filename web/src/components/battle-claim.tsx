"use client";

import { Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { TokenIcon } from "@/components/token-icon";
import { Button } from "@/components/ui/button";
import { useAction } from "@/hooks/use-action";
import { useActionRunner } from "@/hooks/use-action-runner";
import { formatUnits } from "@/lib/amounts";
import { TOKEN_DECIMALS } from "@/lib/arena-read/balances";
import { buildClaimReview, buildRegisterReview, claimRequest, readEntitlement, readRegistered, registerRequest } from "@/lib/arena-read/claim";
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
export function BattleClaim({ arena, battleId, backings }: { arena: string; battleId: number; backings: readonly string[] }) {
  const { act, accountId, connected } = useActionRunner();
  const action = useAction();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [step, setStep] = useState<ReturnType<typeof daoStep> | null>(null);
  const key = backings.join(",");

  const refresh = useCallback(async () => {
    if (!accountId) return;
    const [disposition, found] = await Promise.all([
      readDisposition(config.rpcUrl, arena, battleId),
      Promise.all(backings.map(async (backing) => ({ backing, available: await readEntitlement(config.rpcUrl, backing, accountId) }))),
    ]);
    setStep(daoStep(disposition));
    setRows(found.filter((r) => BigInt(r.available) > 0n));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, arena, battleId, key]);

  useEffect(() => {
    const tick = () => void refresh().catch(() => undefined);
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const claim = (r: Row) =>
    action.run(async () => {
      if (!accountId) throw new Error("connect a wallet first");
      const label = symbolOf(r.backing);
      if (!(await readRegistered(config.rpcUrl, r.backing, accountId))) {
        const register = buildRegisterReview(r.backing, accountId, label);
        await act(registerRequest(r.backing), register.ok ? register : null);
      }
      const review = buildClaimReview(r.backing, r.available, label);
      await act(claimRequest(r.backing, r.available), review.ok ? review : null);
      await refresh();
    });

  // The claim opens when the DAO is done, never decided, or the battle has no vote at all.
  const open = step !== null && (step.kind === "done" || step.kind === "undecided" || step.kind === "none");
  if (step === null || rows === null) return null;
  if (!open) return <p className="mt-4 text-sm text-mute">Claiming opens after the DAO decision.</p>;
  if (rows.length === 0) return <p className="mt-4 text-sm text-mute">No prize to claim yet. It appears here after the battle is settled.</p>;

  return (
    <div className="mt-4 space-y-3">
      {rows.map((r) => (
        <div key={r.backing} className="flex items-center justify-between gap-3 rounded-xl p-3" style={{ background: "#fffdf6", border: "1px solid #d8dfd3" }}>
          <div className="flex min-w-0 items-center gap-3">
            <TokenIcon symbol={symbolOf(r.backing)} size={36} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tabular-nums">{formatUnits(BigInt(r.available), TOKEN_DECIMALS, 4)} {symbolOf(r.backing)}</p>
              <p className="text-xs text-mute">Goes to your NEAR wallet</p>
            </div>
          </div>
          <Button type="button" disabled={action.busy || !connected} onClick={() => void claim(r)}>
            <Wallet size={16} aria-hidden="true" /> {action.busy ? "Claiming…" : "Claim"}
          </Button>
        </div>
      ))}
      {action.error && <p role="alert" className="text-xs text-neon-red">{action.error}</p>}
    </div>
  );
}
