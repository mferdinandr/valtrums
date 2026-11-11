"use client";

import { useCallback, useEffect, useRef } from "react";
import { useActionWallet, useWallet } from "@/components/providers";
import { ActionSession, createActionWallet } from "@/lib/arena-read/action-session";
import { previewCreate } from "@/lib/arena-read/create-flow";
import type { CallReview } from "@/lib/arena-read/create-review";
import { executeTerminalAction } from "@/lib/terminal/actions";

/**
 * Runs one reviewed action end to end: the service's canonical preview is compared with the call the page
 * reviewed (a mismatch stops everything before the wallet is asked for anything), then it is authorized, signed
 * and confirmed from a verified receipt. The session token stays in memory and is dropped when the account changes.
 * Throws with a readable message on any failure; it never retries a broadcast on its own.
 */
export function useActionRunner() {
  const { accountId } = useWallet();
  const getWallet = useActionWallet();
  const session = useRef<{ account: string; value: ActionSession } | null>(null);
  useEffect(() => {
    session.current = null;
  }, [accountId]);

  const act = useCallback(
    async (request: Record<string, unknown>, review: CallReview | null) => {
      if (!accountId || !getWallet) throw new Error("connect a wallet first");
      if (!review) throw new Error("the reviewed call is not valid");
      const wallet = await getWallet();
      if (session.current?.account !== accountId) session.current = { account: accountId, value: new ActionSession({ accountId, wallet }) };
      const active = session.current.value;
      const deps = { session: await active.ensure(), wallet: createActionWallet(active, { accountId, wallet }) };
      const outcome = await previewCreate(request, review, accountId, deps);
      if (outcome.step === "blocked") throw new Error(`the prepared transaction does not match what you reviewed (${outcome.reasons.join("; ")}). Nothing was signed.`);
      const result = await executeTerminalAction(outcome.previewed, deps);
      if (!result.ok) throw new Error(`${result.reason}${result.txHash ? ` (transaction ${result.txHash})` : ""}`);
      return result;
    },
    [accountId, getWallet],
  );

  return { act, accountId, connected: !!accountId && !!getWallet };
}
