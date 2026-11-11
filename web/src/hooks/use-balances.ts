"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@/components/providers";
import { readBalances, type AccountBalances } from "@/lib/arena-read/balances";
import { config } from "@/lib/config";

/** Other parts of the app dispatch this after a transaction that changes balances (for example a faucet claim). */
export const BALANCES_STALE_EVENT = "valtrum:balances-stale";
const POLL_MS = 15_000;

/**
 * The connected account's NEAR and faucet-token balances, read over RPC. It refreshes on a timer and whenever a
 * transaction that moves tokens reports it is done. A different account drops stale answers.
 */
export function useBalances() {
  const { accountId } = useWallet();
  const contract = config.faucetContract;
  const [balances, setBalances] = useState<AccountBalances | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    if (!accountId || !contract) {
      setBalances(null);
      return;
    }
    setLoading(true);
    try {
      const next = await readBalances(config.rpcUrl, contract, accountId);
      if (mine === generation.current) {
        setBalances(next);
        setError(null);
      }
    } catch (e) {
      if (mine === generation.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [accountId, contract]);

  useEffect(() => {
    setBalances(null);
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const onStale = () => void refresh();
    window.addEventListener(BALANCES_STALE_EVENT, onStale);
    return () => {
      clearInterval(timer);
      window.removeEventListener(BALANCES_STALE_EVENT, onStale);
    };
  }, [refresh]);

  return { accountId, balances, error, loading, refresh, configured: !!contract };
}
