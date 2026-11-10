"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useActionWallet, useWallet } from "@/components/providers";
import { ActionSession, createActionWallet } from "@/lib/arena-read/action-session";
import { previewCreate } from "@/lib/arena-read/create-flow";
import type { ReviewResult } from "@/lib/arena-read/create-review";
import { executeTerminalAction, type ActionRunResult, type PreviewedAction } from "@/lib/terminal/actions";

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
 * Drives preview, comparison and execution of a create_lifecycle_battle action. The session token stays in
 * memory only. The flow cannot reach authorization unless the server's preview equals the reviewed call, and
 * a wallet rejection or an error leaves the review untouched so the user can retry. Nothing here retries a
 * broadcast on its own.
 */
export function useLifecycleCreate(request: Record<string, unknown>, review: Extract<ReviewResult, { ok: true }> | null) {
  const { accountId } = useWallet();
  const getWallet = useActionWallet();
  const [flow, setFlow] = useState<CreateFlow>({ step: "idle" });
  const session = useRef<{ account: string; value: ActionSession } | null>(null);

  // A different account or a sign-out discards the session and any pending preview.
  useEffect(() => {
    session.current = null;
    setFlow({ step: "idle" });
  }, [accountId]);

  const deps = useCallback(async () => {
    if (!accountId || !getWallet) throw new Error("connect a wallet first");
    const wallet = await getWallet();
    if (session.current?.account !== accountId) session.current = { account: accountId, value: new ActionSession({ accountId, wallet }) };
    const active = session.current.value;
    return { token: await active.ensure(), wallet: createActionWallet(active, { accountId, wallet }) };
  }, [accountId, getWallet]);

  const preview = useCallback(async () => {
    if (!review || !accountId) return;
    setFlow({ step: "previewing" });
    try {
      const { token, wallet } = await deps();
      const outcome = await previewCreate(request, review, accountId, { session: token, wallet });
      setFlow(outcome.step === "blocked" ? { step: "blocked", reasons: outcome.reasons } : { step: "previewed", previewed: outcome.previewed });
    } catch (err) {
      setFlow({ step: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [deps, request, review, accountId]);

  const execute = useCallback(async () => {
    if (flow.step !== "previewed") return;
    const { previewed } = flow;
    setFlow({ step: "signing" });
    try {
      const { token, wallet } = await deps();
      setFlow({ step: "done", result: await executeTerminalAction(previewed, { session: token, wallet }) });
    } catch (err) {
      setFlow({ step: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [flow, deps]);

  const reset = useCallback(() => setFlow({ step: "idle" }), []);
  return { flow, preview, execute, reset, connected: !!accountId && !!getWallet };
}
