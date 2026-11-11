"use client";

import { useCallback, useRef, useState } from "react";
import { useActionRunner } from "@/hooks/use-action-runner";
import { buildDepositReview, depositRequest } from "@/lib/arena-read/deposit-flow";
import { readCommunityState, readRegistered } from "@/lib/arena-read/join-deposit";
import { buildJoinReview, joinRequest } from "@/lib/arena-read/open-arena";
import { config } from "@/lib/config";

export type JoinStage = "join" | "approval" | "deposit";
export const JOIN_STAGE_TEXT: Record<JoinStage, string> = {
  join: "Adding your token to the battle…",
  approval: "Waiting for the token's audit approval. This can take a minute.",
  deposit: "Depositing your tokens…",
};

export type JoinState =
  | { step: "idle" }
  | { step: "running"; stage: JoinStage }
  | { step: "failed"; message: string }
  | { step: "done" };

/** Preserve the approval deadline while detecting completion sooner. One request at a time. */
const APPROVAL_TIMEOUT_MS = 90_000;
const APPROVAL_WAIT_MS = 1_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One click that puts a deposit into an open battle: it adds the token as a community and registers the account
 * when that has not happened yet, waits for the community's approvals, then deposits. Every step is previewed and
 * compared with the call the page reviewed before the wallet is asked for anything. A failure stops the run and the
 * next click continues from what is still missing, so nothing is done twice.
 */
export function useJoinAndDeposit(arena: string, battleId: number) {
  const { act, accountId, connected } = useActionRunner();
  const [state, setState] = useState<JoinState>({ step: "idle" });
  const scope = `${accountId}:${arena}:${battleId}`;
  const [receipts, setReceipts] = useState<{ scope: string; hashes: string[] }>({ scope, hashes: [] });
  const busy = useRef(false);

  const run = useCallback(
    async (representation: string, label: string, amount: string) => {
      if (!accountId || busy.current) return;
      busy.current = true;
      const remember = (hash?: string | null) => { if (hash) setReceipts((previous) => ({ scope, hashes: [...new Set([...(previous.scope === scope ? previous.hashes : []), hash])] })); };
      try {
        let current = await readCommunityState(config.rpcUrl, arena, battleId, representation);
        const registered = current.index !== null && (await readRegistered(config.rpcUrl, arena, battleId, current.index, accountId));
        if (!registered) {
          setState({ step: "running", stage: "join" });
          const review = buildJoinReview(arena, battleId, representation, label);
          const joined = await act(joinRequest(battleId, representation), review.ok ? review : null);
          remember(joined.txHash);
          current = await readCommunityState(config.rpcUrl, arena, battleId, representation);
        }
        const approvalDeadline = Date.now() + APPROVAL_TIMEOUT_MS;
        while (!(current.index !== null && current.approved) && Date.now() < approvalDeadline) {
          setState({ step: "running", stage: "approval" });
          await sleep(APPROVAL_WAIT_MS);
          current = await readCommunityState(config.rpcUrl, arena, battleId, representation).catch(() => current);
        }
        if (current.index === null || !current.approved) {
          throw new Error("the token has no audit approval yet. The audit service approves it on its own schedule; press the button again to continue");
        }
        setState({ step: "running", stage: "deposit" });
        const review = buildDepositReview({ arena, representation, battleId, community: current.index, amount });
        const deposited = await act(depositRequest(battleId, current.index, amount), review.ok ? review : null);
        remember(deposited.txHash);
        setState({ step: "done" });
      } catch (e) {
        setState({ step: "failed", message: e instanceof Error ? e.message : String(e) });
      } finally {
        busy.current = false;
      }
    },
    [accountId, act, arena, battleId, scope],
  );

  return { state, run, connected, txHashes: receipts.scope === scope ? receipts.hashes : [], reset: () => setState({ step: "idle" }) };
}
