"use client";

import { Wallet } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useActionWallet, useWallet } from "@/components/providers";
import { useAction } from "@/hooks/use-action";
import { buildClaimBatch, outcomeFailure, readEntitlement, readRegistered, symbolOf, type ClaimBatchItem } from "@/lib/arena-read/claim";
import { config } from "@/lib/config";

export interface ClaimRow {
  backing: string;
  available: string;
}

const CONFIRM_TRIES = 8;
const CONFIRM_DELAY_MS = 1_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One button that gets every prize into the connected NEAR account with a single wallet approval: `prepare` first (for
 * example settling the battle), then one transaction per token owed (a registration where needed, then the claim), all
 * sent together. A wallet without batch support signs them one at a time instead. The entitlements are read again
 * afterwards, and anything still owed is reported so the next click continues from what is left; nothing is claimed twice.
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
  const { accountId } = useWallet();
  const getWallet = useActionWallet();
  const connected = !!accountId && !!getWallet;
  const action = useAction();
  const [status, setStatus] = useState<string | null>(null);

  const owedNow = async (account: string, list: readonly string[]) => {
    const rows: ClaimRow[] = [];
    for (const backing of list) {
      const available = await readEntitlement(config.rpcUrl, backing, account);
      if (BigInt(available) > 0n) rows.push({ backing, available });
    }
    return rows;
  };

  const claimAll = () =>
    action.run(async () => {
      if (!accountId || !getWallet) throw new Error("connect a wallet first");
      try {
        if (prepare) await prepare(setStatus);
        const owed = await owedNow(accountId, backings);
        if (owed.length === 0) throw new Error("There is nothing to claim yet.");
        const items: ClaimBatchItem[] = [];
        for (const r of owed) items.push({ ...r, registered: await readRegistered(config.rpcUrl, r.backing, accountId) });
        const batch = buildClaimBatch(accountId, items);
        if (!batch.ok) throw new Error(batch.problems.join("; "));

        setStatus(`Claiming ${owed.length} ${owed.length === 1 ? "token" : "tokens"}…`);
        const wallet = await getWallet();
        if (wallet.signAndSendTransactions) {
          const failure = outcomeFailure(await wallet.signAndSendTransactions({ transactions: batch.transactions }));
          if (failure) throw new Error(`A claim failed: ${failure}`);
        } else {
          for (const [i, tx] of batch.transactions.entries()) {
            setStatus(`Claiming ${i + 1} of ${batch.transactions.length}…`);
            const failure = outcomeFailure(await wallet.signAndSendTransaction(tx));
            if (failure) throw new Error(`The claim of ${symbolOf(tx.receiverId)} failed: ${failure}`);
          }
        }

        // The chain view can trail the transactions by a few blocks: wait until nothing is owed any more.
        setStatus("Confirming…");
        let left = owed;
        for (let i = 0; i < CONFIRM_TRIES && left.length > 0; i++) {
          if (i > 0) await sleep(CONFIRM_DELAY_MS);
          left = await owedNow(accountId, owed.map((r) => r.backing));
        }
        if (left.length > 0) throw new Error(`Not credited yet: ${left.map((r) => symbolOf(r.backing)).join(", ")}.`);
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
      {action.busy && <p role="status" className="text-xs text-mute">Confirm in your wallet.</p>}
      {action.error && <p role="alert" className="text-xs text-neon-red">{action.error} Press the button to continue.</p>}
    </div>
  );
}
