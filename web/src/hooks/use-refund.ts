"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useActionWallet, useWallet } from "@/components/providers";
import { ActionSession, createActionWallet } from "@/lib/arena-read/action-session";
import { previewCreate } from "@/lib/arena-read/create-flow";
import type { CallReview } from "@/lib/arena-read/create-review";
import { buildEscrowRefundReview, buildRefundReview, escrowRefundRequest, refundRequest } from "@/lib/arena-read/open-arena";
import { readCreatorEscrow, readMyPositions } from "@/lib/arena-read/positions";
import { config } from "@/lib/config";
import { executeTerminalAction } from "@/lib/terminal/actions";

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

/**
 * Takes back everything the connected account has in a cancelled battle with one click: each credited position
 * and, for the creator, the deposit still held in escrow. Every claim is previewed and compared with the call the
 * page reviewed before the wallet is asked for anything, exactly like a single action; a failure stops the run and
 * a second click continues from what is still owed, so nothing is claimed twice.
 */
export function useRefund(arena: string, battleId: number, communityCount: number, nameOf: (community: number) => string) {
  const { accountId } = useWallet();
  const getWallet = useActionWallet();
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [state, setState] = useState<RefundState>({ step: "idle" });
  const session = useRef<{ account: string; value: ActionSession } | null>(null);
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
    session.current = null;
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
      setState({ step: "running", done: 0, total: todo.length });
      const wallet = await getWallet();
      if (session.current?.account !== accountId) session.current = { account: accountId, value: new ActionSession({ accountId, wallet }) };
      const active = session.current.value;
      for (const [i, claim] of todo.entries()) {
        const review: CallReview | null = (() => {
          const r = claim.kind === "position"
            ? buildRefundReview(arena, battleId, claim.community, nameOf(claim.community))
            : buildEscrowRefundReview(arena, battleId);
          return r.ok ? r : null;
        })();
        if (!review) throw new Error("the reviewed call is not valid");
        const request = claim.kind === "position" ? refundRequest(battleId, claim.community) : escrowRefundRequest(battleId);
        const deps = { session: await active.ensure(), wallet: createActionWallet(active, { accountId, wallet }) };
        const outcome = await previewCreate(request, review, accountId, deps);
        if (outcome.step === "blocked") throw new Error(`the prepared transaction does not match what you reviewed (${outcome.reasons.join("; ")}). Nothing was signed.`);
        const result = await executeTerminalAction(outcome.previewed, deps);
        if (!result.ok) throw new Error(`${result.reason}${result.txHash ? ` (transaction ${result.txHash})` : ""}`);
        setState({ step: "running", done: i + 1, total: todo.length });
      }
      setClaims(await read().catch(() => []));
      setState({ step: "done" });
    } catch (e) {
      setState({ step: "failed", message: e instanceof Error ? e.message : String(e) });
    } finally {
      busy.current = false;
    }
  }, [accountId, getWallet, read, arena, battleId, nameOf]);

  return { claims, state, run, connected: !!accountId && !!getWallet };
}
