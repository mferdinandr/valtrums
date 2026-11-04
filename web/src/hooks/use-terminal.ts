"use client";

import { useMemo, useRef, useSyncExternalStore } from "react";
import { useArena, useTerminalEnv, useWallet } from "@/components/providers";
import { createRouteParser } from "@/lib/terminal/parse-client";
import { createTerminal, type HistoryEntry, type TerminalController, type TerminalState } from "@/lib/terminal/machine";

export interface UseTerminal {
  controller: TerminalController;
  state: TerminalState;
  history: readonly HistoryEntry[];
}

/** One terminal controller per page; `scopeBattleId` narrows prompts to a single battle. */
export function useTerminal(scopeBattleId?: number): UseTerminal {
  const api = useArena();
  const env = useTerminalEnv();
  const { accountId } = useWallet();
  const accountRef = useRef(accountId);
  accountRef.current = accountId;

  const controller = useMemo(
    () =>
      createTerminal({
        parser: createRouteParser(),
        api,
        chain: env.chain,
        sender: env.sender,
        funding: env.funding,
        getAccountId: () => accountRef.current,
        scopeBattleId,
      }),
    [api, env, scopeBattleId],
  );

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const history = useSyncExternalStore(controller.subscribe, controller.getHistory, controller.getHistory);
  return { controller, state, history };
}
