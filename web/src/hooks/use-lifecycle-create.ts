"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useActionWallet, useWallet } from "@/components/providers";
import {
  ActionSession,
  createActionWallet,
} from "@/lib/arena-read/action-session";
import { previewCreate } from "@/lib/arena-read/create-flow";
import { readCredit } from "@/lib/arena-read/deposit-flow";
import {
  ReviewScope,
  reviewScopeKey,
  scopeWallet,
} from "@/lib/arena-read/review-scope";
import type { CallReview } from "@/lib/arena-read/create-review";
import {
  executeTerminalAction,
  type ActionRunResult,
  type PreviewedAction,
} from "@/lib/terminal/actions";

export type CreateFlow =
  | { step: "idle" }
  | { step: "previewing" }
  /** The server's canonical preview matches the reviewed call. Nothing is authorized yet. */
  | { step: "previewed"; previewed: PreviewedAction }
  | { step: "blocked"; reasons: string[] }
  | { step: "signing" }
  | { step: "done"; result: ActionRunResult }
  | { step: "error"; message: string };

/**
 * Drives preview, comparison and execution of one reviewed action (create, register or deposit). The session token stays in
 * memory only. The flow cannot reach authorization unless the server's preview equals the reviewed call, and
 * a wallet rejection or an error leaves the review untouched so the user can retry. Nothing here retries a
 * broadcast on its own.
 */
export function useLifecycleCreate(
  request: Record<string, unknown>,
  review: CallReview | null,
  namespace = "",
) {
  const { accountId } = useWallet();
  const getWallet = useActionWallet();
  const scope = useRef(new ReviewScope());
  const key = reviewScopeKey(accountId, namespace, request, review);
  scope.current.select(key);
  const [stored, setStored] = useState<{
    token: number;
    flow: CreateFlow;
  } | null>(null);
  const flow: CreateFlow =
    stored && scope.current.current(stored.token)
      ? stored.flow
      : { step: "idle" };
  const commit = useCallback((token: number, next: CreateFlow) => {
    if (scope.current.current(token)) setStored({ token, flow: next });
  }, []);
  useEffect(() => () => scope.current.invalidate(), []);
  const session = useRef<{ account: string; value: ActionSession } | null>(
    null,
  );

  // A different account or a sign-out discards the session and any pending preview.
  useEffect(() => {
    session.current = null;
  }, [accountId]);

  const deps = useCallback(async () => {
    if (!accountId || !getWallet) throw new Error("connect a wallet first");
    const wallet = await getWallet();
    if (session.current?.account !== accountId)
      session.current = {
        account: accountId,
        value: new ActionSession({ accountId, wallet }),
      };
    const active = session.current.value;
    return {
      token: await active.ensure(),
      wallet: createActionWallet(active, { accountId, wallet }),
    };
  }, [accountId, getWallet]);

  const preview = useCallback(async () => {
    if (!review || !accountId) return;
    const tokenId = scope.current.begin();
    commit(tokenId, { step: "previewing" });
    try {
      const { token, wallet } = await deps();
      if (!scope.current.current(tokenId)) return;
      const outcome = await previewCreate(request, review, accountId, {
        session: token,
        wallet,
      });
      commit(
        tokenId,
        outcome.step === "blocked"
          ? { step: "blocked", reasons: outcome.reasons }
          : { step: "previewed", previewed: outcome.previewed },
      );
    } catch (err) {
      commit(tokenId, {
        step: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [deps, request, review, accountId, commit]);

  const execute = useCallback(async () => {
    if (
      flow.step !== "previewed" ||
      !stored ||
      !scope.current.current(stored.token)
    )
      return;
    const tokenId = stored.token;
    const { previewed } = flow;
    commit(tokenId, { step: "signing" });
    try {
      const { token, wallet } = await deps();
      if (!scope.current.current(tokenId)) return;
      const guarded = scopeWallet(wallet, () => scope.current.current(tokenId));
      commit(tokenId, {
        step: "done",
        result: await executeTerminalAction(previewed, {
          session: token,
          wallet: guarded,
        }),
      });
    } catch (err) {
      commit(tokenId, {
        step: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [flow, stored, deps, commit]);

  const reset = useCallback(() => {
    scope.current.invalidate();
    setStored(null);
  }, []);
  /** The account's position as the arena reports it, read through the action status. Null when unavailable. */
  const readPosition = useCallback(
    async (actionId: string) => {
      try {
        const { token, wallet } = await deps();
        return await readCredit(actionId, { session: token, wallet });
      } catch {
        return null;
      }
    },
    [deps],
  );
  return {
    flow,
    preview,
    execute,
    reset,
    readPosition,
    connected: !!accountId && !!getWallet,
  };
}
