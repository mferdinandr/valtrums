"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useActionWallet, useWallet } from "@/components/providers";
import { buildClaimCall, claimBatches, readFaucet, type FaucetState } from "@/lib/arena-read/faucet";
import { config } from "@/lib/config";

export type ClaimOutcome = { symbol: string; ok: boolean; message: string };

/**
 * The faucet contract's offer and this account's cooldowns, read over RPC, and claims signed by the user's own wallet.
 * Reading needs no wallet; a claim is an ordinary transaction. A different account drops stale answers.
 */
export function useFaucet() {
  const { accountId } = useWallet();
  const getWallet = useActionWallet();
  const contract = config.faucetContract;
  const [state, setState] = useState<FaucetState | null>(null);
  const [outcomes, setOutcomes] = useState<ClaimOutcome[]>([]);
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!contract) return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await readFaucet(config.rpcUrl, contract, accountId, Date.now());
      if (mine === generation.current) setState(next);
    } catch (e) {
      if (mine === generation.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [contract, accountId]);

  useEffect(() => {
    setOutcomes([]);
    void refresh();
  }, [refresh]);

  /** Claims the given tokens, two per wallet approval; a pair is atomic (both or neither). */
  const claim = useCallback(
    async (tokens: ReadonlyArray<{ token: string; symbol: string }>) => {
      if (!contract || !getWallet) {
        setError("connect a wallet first");
        return;
      }
      setError(null);
      const done: ClaimOutcome[] = [];
      for (const batch of claimBatches(tokens)) {
        setClaiming(batch.map((t) => t.symbol).join(" + "));
        try {
          const wallet = await getWallet();
          await wallet.signAndSendTransaction(buildClaimCall(contract, batch.map((t) => t.token)));
          for (const t of batch) done.push({ symbol: t.symbol, ok: true, message: "Submitted. The tokens arrive once the transaction is final." });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          for (const t of batch) done.push({ symbol: t.symbol, ok: false, message });
          break;
        }
      }
      setClaiming(null);
      setOutcomes(done);
      setTimeout(() => void refresh(), 4_000);
    },
    [contract, getWallet, refresh],
  );

  return { accountId, contract, connected: !!accountId && !!getWallet, state, outcomes, loading, claiming, error, refresh, claim };
}
