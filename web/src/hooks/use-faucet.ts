"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useActionWallet, useWallet } from "@/components/providers";
import { ActionSession } from "@/lib/arena-read/action-session";
import { claimFaucet, fetchFaucetStatus, type FaucetClaim, type FaucetStatus } from "@/lib/arena-read/faucet";

/**
 * Status and claims for the signed-in account. The read session token stays in memory only and is created with a
 * wallet signature that grants no spending authority. A different account or a sign-out drops everything.
 */
export function useFaucet() {
  const { accountId } = useWallet();
  const getWallet = useActionWallet();
  const [status, setStatus] = useState<FaucetStatus | null>(null);
  const [results, setResults] = useState<FaucetClaim[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<{ account: string; value: ActionSession } | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    session.current = null;
    setStatus(null);
    setResults(null);
    setError(null);
  }, [accountId]);

  const token = useCallback(async (): Promise<string> => {
    if (!accountId || !getWallet) throw new Error("connect a wallet first");
    const wallet = await getWallet();
    if (session.current?.account !== accountId) session.current = { account: accountId, value: new ActionSession({ accountId, wallet }) };
    return session.current.value.ensure();
  }, [accountId, getWallet]);

  const refresh = useCallback(async () => {
    const mine = generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchFaucetStatus(await token());
      if (mine === generation.current) setStatus(next);
    } catch (e) {
      if (mine === generation.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [token]);

  const claim = useCallback(
    async (symbols?: readonly string[]) => {
      const mine = generation.current;
      setClaiming(true);
      setError(null);
      try {
        const out = await claimFaucet(await token(), symbols);
        if (mine !== generation.current) return;
        setResults(out.results);
        setStatus(await fetchFaucetStatus(await token()));
      } catch (e) {
        if (mine === generation.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mine === generation.current) setClaiming(false);
      }
    },
    [token],
  );

  return { accountId, connected: !!accountId && !!getWallet, status, results, loading, claiming, error, refresh, claim };
}
