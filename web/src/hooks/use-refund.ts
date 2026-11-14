"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useActionWallet, useWallet } from "@/components/providers";
import { txHashOf } from "@/lib/arena-read/action-session";
import { outcomeFailure } from "@/lib/arena-read/claim";
import { buildRefundBatch } from "@/lib/arena-read/open-arena";
import { readCreatorEscrow, readMyPositions } from "@/lib/arena-read/positions";
import { config } from "@/lib/config";

/** One thing the connected account can take back from a cancelled battle. */
export type Claim =
  | { kind: "position"; community: number; amount: string }
  | { kind: "escrow"; representation: string; amount: string };

export type RefundState =
  | { step: "idle" }
  | { step: "running"; done: number; total: number }
  | { step: "failed"; message: string }
  | { step: "done" };

const POLL_MS = 5_000;

const CONFIRM_TRIES = 8;
const CONFIRM_DELAY_MS = 1_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Takes back everything the connected account has in a failed battle with one click and one wallet approval: each
 * credited position and, for the creator, the deposit still held in escrow. With `cancelFirst` the same transaction
 * also cancels the battle, so a depositor never has to cancel as a separate step. The calls are signed as one
 * transaction to the arena (split only if their gas would not fit); afterwards what is still owed is read again, and
 * a failure leaves the next click to continue from what is left, so nothing is claimed twice.
 */
export function useRefund(arena: string, battleId: number, communityCount: number, nameOf: (community: number) => string, cancelFirst = false) {
  const { accountId } = useWallet();
  const getWallet = useActionWallet();
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [state, setState] = useState<RefundState>({ step: "idle" });
  const scope = `${accountId}:${arena}:${battleId}`;
  const [receipts, setReceipts] = useState<{ scope: string; hashes: string[] }>({ scope, hashes: [] });
  const busy = useRef(false);

  const read = useCallback(async (): Promise<Claim[]> => {
    if (!accountId) return [];
    const [positions, escrow] = await Promise.all([
      readMyPositions(config.rpcUrl, arena, battleId, accountId, communityCount),
      readCreatorEscrow(config.rpcUrl, arena, battleId),
    ]);
    const out: Claim[] = positions
      .filter((p) => p.amount !== "0")
      .map((p) => ({ kind: "position", community: p.community, amount: p.amount }));
    if (escrow && escrow.creator === accountId) out.push({ kind: "escrow", representation: escrow.representation, amount: escrow.amount });
    return out;
  }, [accountId, arena, battleId, communityCount]);

  useEffect(() => {
    setState({ step: "idle" });
    if (!accountId) {
      setClaims(null);
      return;
    }
    let live = true;
    const tick = () => {
      if (busy.current) return;
      read().then((c) => live && setClaims(c)).catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [accountId, read]);

  const run = useCallback(async () => {
    if (!accountId || !getWallet || busy.current) return;
    busy.current = true;
    try {
      // What is still owed right now, not what the page showed a moment ago.
      const todo = await read();
      const batch = buildRefundBatch(arena, battleId, {
        cancel: cancelFirst,
        positions: todo.flatMap((c) => (c.kind === "position" ? [{ community: c.community, label: nameOf(c.community) }] : [])),
        escrow: todo.some((c) => c.kind === "escrow"),
      });
      if (!batch.ok) throw new Error(batch.problems.join("; "));
      const total = batch.transactions.length;
      setState({ step: "running", done: 0, total });
      const wallet = await getWallet();
      const remember = (outcome: unknown) => {
        const hash = txHashOf(outcome);
        if (hash) setReceipts((previous) => ({ scope, hashes: [...new Set([...(previous.scope === scope ? previous.hashes : []), hash])] }));
      };
      if (wallet.signAndSendTransactions && total > 1) {
        const outcome = await wallet.signAndSendTransactions({ transactions: batch.transactions });
        for (const o of Array.isArray(outcome) ? outcome : [outcome]) remember(o);
        const failure = outcomeFailure(outcome);
        if (failure) throw new Error(`The refund failed: ${failure}`);
      } else {
        for (const [i, tx] of batch.transactions.entries()) {
          const outcome = await wallet.signAndSendTransaction(tx);
          remember(outcome);
          const failure = outcomeFailure(outcome);
          if (failure) throw new Error(`The refund failed: ${failure}`);
          setState({ step: "running", done: i + 1, total });
        }
      }
      // The chain view can trail the transaction by a few blocks: wait until nothing is owed any more.
      let left = await read();
      for (let i = 0; i < CONFIRM_TRIES && left.length > 0; i++) {
        await sleep(CONFIRM_DELAY_MS);
        left = await read();
      }
      setClaims(left);
      if (left.length > 0) throw new Error("The refund is not recorded yet.");
      setState({ step: "done" });
    } catch (e) {
      setState({ step: "failed", message: e instanceof Error ? e.message : String(e) });
    } finally {
      busy.current = false;
    }
  }, [accountId, getWallet, read, arena, battleId, nameOf, scope, cancelFirst]);

  return { claims, state, run, txHashes: receipts.scope === scope ? receipts.hashes : [], connected: !!accountId && !!getWallet };
}
