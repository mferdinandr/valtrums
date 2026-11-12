"use client";

import { Wallet } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/hooks/use-action";
import { useActionRunner } from "@/hooks/use-action-runner";
import { buildClaimReview, buildRegisterReview, claimRequest, readEntitlement, readRegistered, registerRequest, symbolOf } from "@/lib/arena-read/claim";
import { config } from "@/lib/config";

export interface ClaimRow {
  backing: string;
  available: string;
}

/**
 * One button that claims everything owed into the connected NEAR account, token by token, registering the account
 * on a token first where needed. A failure stops the run and the next click continues from what is still owed (the
 * entitlement is read again before each claim), so nothing is claimed twice.
 */
export function ClaimAllButton({ rows, onDone, disabled }: { rows: readonly ClaimRow[]; onDone?: () => void | Promise<void>; disabled?: boolean }) {
  const { act, accountId, connected } = useActionRunner();
  const action = useAction();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const claimAll = () =>
    action.run(async () => {
      if (!accountId) throw new Error("connect a wallet first");
      try {
        for (const [i, r] of rows.entries()) {
          setProgress({ done: i, total: rows.length });
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
        setProgress(null);
        await Promise.resolve(onDone?.()).catch(() => undefined);
      }
    });

  return (
    <div className="space-y-2">
      <Button type="button" className="w-full" disabled={disabled || action.busy || !connected || rows.length === 0} onClick={() => void claimAll()}>
        <Wallet size={16} aria-hidden="true" />{" "}
        {progress ? `Claiming ${progress.done + 1} of ${progress.total}…` : rows.length > 1 ? "Claim all to my NEAR wallet" : "Claim to my NEAR wallet"}
      </Button>
      {progress && <p role="status" className="text-xs text-mute">Confirm each step in your wallet.</p>}
      {action.error && <p role="alert" className="text-xs text-neon-red">{action.error} Press the button to continue.</p>}
    </div>
  );
}
