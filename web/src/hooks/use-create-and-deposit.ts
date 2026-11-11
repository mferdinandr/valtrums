"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useActionWallet, useWallet } from "@/components/providers";
import { ActionSession, createActionWallet } from "@/lib/arena-read/action-session";
import { buildPrepayReview, CREATE_STORAGE_MIN_YOCTO, prepayRequest, type CallReview } from "@/lib/arena-read/create-review";
import { previewCreate } from "@/lib/arena-read/create-flow";
import { readCreateOutcome, readStorageBalance } from "@/lib/arena-read/create-deposit";
import { config } from "@/lib/config";
import { executeTerminalAction } from "@/lib/terminal/actions";

export type Stage = "prepay" | "create";
export const STAGE_NAME: Record<Stage, string> = { prepay: "Prepaying battle storage", create: "Creating the battle" };
export const STAGE_TEXT: Record<Stage, string> = {
  prepay: "Prepaying the NEAR that pays your battle's storage…",
  create: "Creating your battle with your deposit…",
};

export type RunState =
  | { step: "idle" }
  | { step: "running"; stage: Stage }
  | { step: "failed"; stage: Stage; message: string; battleId: number | null }
  | { step: "done"; battleId: number };

export interface Plan {
  arena: string;
  createRequest: Record<string, unknown>;
  createReview: CallReview | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One click that creates a battle with the creator's deposit (D41). When the account has not prepaid enough
 * storage on the arena, a small prepayment is confirmed first. Each step is previewed and compared with the
 * call the page reviewed before the wallet is asked for anything, exactly like a single action. The creation
 * is one transaction: the arena either creates the battle and holds the deposit in escrow, or refuses and the
 * token returns the whole transfer. Progress is kept, so a failed read of the outcome does not send the tokens
 * twice. The arena page reads the position and the escrow from the arena.
 */
export function useCreateAndDeposit(plan: Plan) {
  const { accountId } = useWallet();
  const getWallet = useActionWallet();
  const [state, setState] = useState<RunState>({ step: "idle" });
  const progress = useRef<{ txHash: string | null; battleId: number | null }>({ txHash: null, battleId: null });
  const session = useRef<{ account: string; value: ActionSession } | null>(null);
  const busy = useRef(false);

  // A different account starts over; nothing from another account's run is reused.
  useEffect(() => {
    session.current = null;
    progress.current = { txHash: null, battleId: null };
    setState({ step: "idle" });
  }, [accountId]);

  const deps = useCallback(async () => {
    if (!accountId || !getWallet) throw new Error("connect a wallet first");
    const wallet = await getWallet();
    if (session.current?.account !== accountId) session.current = { account: accountId, value: new ActionSession({ accountId, wallet }) };
    const active = session.current.value;
    return { session: await active.ensure(), wallet: createActionWallet(active, { accountId, wallet }) };
  }, [accountId, getWallet]);

  const run = useCallback(async () => {
    if (!accountId || busy.current) return;
    busy.current = true;
    const p = progress.current;
    let stage: Stage = "create";
    const act = async (request: Record<string, unknown>, review: CallReview | null) => {
      if (!review) throw new Error("the reviewed call is not valid");
      const d = await deps();
      const outcome = await previewCreate(request, review, accountId, d);
      if (outcome.step === "blocked") throw new Error(`the prepared transaction does not match what you reviewed (${outcome.reasons.join("; ")}). Nothing was signed.`);
      const result = await executeTerminalAction(outcome.previewed, d);
      if (!result.ok) throw new Error(`${result.reason}${result.txHash ? ` (transaction ${result.txHash})` : ""}`);
      return result;
    };
    try {
      if (p.txHash === null) {
        const prepaid = await readStorageBalance(config.rpcUrl, plan.arena, accountId);
        if (prepaid < BigInt(CREATE_STORAGE_MIN_YOCTO)) {
          stage = "prepay";
          setState({ step: "running", stage });
          const review = buildPrepayReview(plan.arena);
          await act(prepayRequest(), review.ok ? review : null);
        }
        stage = "create";
        setState({ step: "running", stage });
        p.txHash = (await act(plan.createRequest, plan.createReview)).txHash;
      }
      stage = "create";
      setState({ step: "running", stage });
      // The outcome is a log of the creation's own receipts; give the chain a moment to execute them.
      let outcome = null;
      for (let i = 0; i < 6 && outcome === null; i++) {
        outcome = await readCreateOutcome(config.rpcUrl, p.txHash as string, accountId).catch(() => null);
        if (outcome === null) await sleep(1_500);
      }
      if (outcome === null) throw new Error("the transaction was sent but its outcome could not be read yet. Press Continue to read it again; your tokens are not sent twice");
      if ("refused" in outcome) {
        p.txHash = null;
        throw new Error(`the arena refused the creation and returned your tokens: ${outcome.refused}`);
      }
      p.battleId = outcome.battleId;
      setState({ step: "done", battleId: outcome.battleId });
    } catch (e) {
      setState({ step: "failed", stage, message: e instanceof Error ? e.message : String(e), battleId: p.battleId });
    } finally {
      busy.current = false;
    }
  }, [accountId, deps, plan]);

  return { state, run, connected: !!accountId && !!getWallet };
}
