"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useActionWallet, useWallet } from "@/components/providers";
import { ActionSession, createActionWallet } from "@/lib/arena-read/action-session";
import type { CallReview } from "@/lib/arena-read/create-review";
import { previewCreate } from "@/lib/arena-read/create-flow";
import { readCommunityIndex, readCreatedBattleId } from "@/lib/arena-read/create-deposit";
import { buildDepositReview, depositRequest } from "@/lib/arena-read/deposit-flow";
import { buildJoinReview, joinRequest } from "@/lib/arena-read/open-arena";
import { config } from "@/lib/config";
import { executeTerminalAction } from "@/lib/terminal/actions";

export type Stage = "create" | "join" | "deposit";
export const STAGE_TEXT: Record<Stage, string> = {
  create: "Step 1 of 3: creating your battle…",
  join: "Step 2 of 3: joining with your token…",
  deposit: "Step 3 of 3: depositing your tokens…",
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
  representation: string;
  label: string;
  /** Base units. */
  amount: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(attempts: number, task: () => Promise<T | null>): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const out = await task();
      if (out !== null) return out;
    } catch (e) {
      if (i === attempts - 1) throw e;
    }
    await sleep(1_500);
  }
  return null;
}

/**
 * One click that creates the battle, joins with the creator's token and deposits it. Every step is previewed
 * and compared with the call the page reviewed before the wallet is asked for anything, exactly like a single
 * action. The battle exists after step 1, so progress is kept: a failed later step resumes from where it
 * stopped instead of creating a second battle. A confirmed deposit is not proof of credit; the arena page reads
 * the position from the arena.
 */
export function useCreateAndDeposit(plan: Plan) {
  const { accountId } = useWallet();
  const getWallet = useActionWallet();
  const [state, setState] = useState<RunState>({ step: "idle" });
  const progress = useRef<{ account: string; txHash: string | null; battleId: number | null; joined: boolean }>({
    account: "", txHash: null, battleId: null, joined: false,
  });
  const session = useRef<{ account: string; value: ActionSession } | null>(null);
  const busy = useRef(false);

  // A different account starts over; nothing from another account's run is reused.
  useEffect(() => {
    session.current = null;
    progress.current = { account: accountId ?? "", txHash: null, battleId: null, joined: false };
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
      if (p.battleId === null) {
        setState({ step: "running", stage });
        if (p.txHash === null) p.txHash = (await act(plan.createRequest, plan.createReview)).txHash;
        p.battleId = await retry(5, () => readCreatedBattleId(config.rpcUrl, p.txHash as string, accountId));
        if (p.battleId === null) throw new Error("the battle was created but its id could not be read yet");
      }
      const battleId = p.battleId;
      if (!p.joined) {
        stage = "join";
        setState({ step: "running", stage });
        await act(joinRequest(battleId, plan.representation), buildJoinReview(plan.arena, battleId, plan.representation, plan.label).ok
          ? (buildJoinReview(plan.arena, battleId, plan.representation, plan.label) as CallReview) : null);
        p.joined = true;
      }
      stage = "deposit";
      setState({ step: "running", stage });
      const community = await retry(5, () => readCommunityIndex(config.rpcUrl, plan.arena, battleId, plan.representation));
      if (community === null) throw new Error("the arena does not list your community yet");
      const depositReview = buildDepositReview({ arena: plan.arena, representation: plan.representation, battleId, community, amount: plan.amount });
      await act(depositRequest(battleId, community, plan.amount), depositReview.ok ? depositReview : null);
      setState({ step: "done", battleId });
    } catch (e) {
      setState({ step: "failed", stage, message: e instanceof Error ? e.message : String(e), battleId: p.battleId });
    } finally {
      busy.current = false;
    }
  }, [accountId, deps, plan]);

  return { state, run, connected: !!accountId && !!getWallet };
}
