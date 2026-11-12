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
 * One button that does everything needed to get the prizes into the connected NEAR account: `prepare` first (for
 * example settling the battle), then every token owed, one by one, registering the account on a token where needed.
 * Each token's entitlement is read again right before its claim, and a failure stops the run: the next click
 * continues from what is still owed, so nothing is claimed twice.
 */
export function ClaimAllButton({
  backings, prepare, onDone, disabled, label = "Claim to my NEAR wallet",
}: {
  backings: readonly string[];
  /** Runs before the claims, for example the settlement of the battle. Throw to stop. */
  prepare?: (say: (text: string) => void) => Promise<void>;
  onDone?: () => void | Promise<void>;
  disabled?: boolean;
  label?: string;
}) {
  const { act, accountId, connected } = useActionRunner();
  const action = useAction();
  const [status, setStatus] = useState<string | null>(null);

  const claimAll = () =>
    action.run(async () => {
      if (!accountId) throw new Error("connect a wallet first");
      try {
        if (prepare) await prepare(setStatus);
        const owed: ClaimRow[] = [];
        for (const backing of backings) {
          const available = await readEntitlement(config.rpcUrl, backing, accountId);
          if (BigInt(available) > 0n) owed.push({ backing, available });
        }
        if (owed.length === 0) throw new Error("There is nothing to claim yet.");
        for (const [i, r] of owed.entries()) {
          setStatus(`Claiming ${i + 1} of ${owed.length}…`);
          const symbol = symbolOf(r.backing);
          if (!(await readRegistered(config.rpcUrl, r.backing, accountId))) {
            const register = buildRegisterReview(r.backing, accountId, symbol);
            await act(registerRequest(r.backing), register.ok ? register : null);
          }
          // What is owed right now, not what was read a moment ago.
          const available = await readEntitlement(config.rpcUrl, r.backing, accountId);
          if (BigInt(available) === 0n) continue;
          const review = buildClaimReview(r.backing, available, symbol);
          await act(claimRequest(r.backing, available), review.ok ? review : null);
        }
      } finally {
        setStatus(null);
        await Promise.resolve(onDone?.()).catch(() => undefined);
      }
    });

  return (
    <div className="space-y-2">
      <Button type="button" className="w-full" disabled={disabled || action.busy || !connected} onClick={() => void claimAll()}>
        <Wallet size={16} aria-hidden="true" /> {action.busy ? status ?? "Working…" : label}
      </Button>
      {action.busy && <p role="status" className="text-xs text-mute">Confirm each step in your wallet.</p>}
      {action.error && <p role="alert" className="text-xs text-neon-red">{action.error} Press the button to continue.</p>}
    </div>
  );
}
