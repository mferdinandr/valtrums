"use client";

import { useEffect, useState } from "react";
import { applicationKey, type Namespace } from "@/lib/arena-read/application";
import { fetchLifecycleBattle, LifecycleReadError, type LifecycleEnvelope } from "@/lib/arena-read/lifecycle";

export interface LifecycleBattleView {
  data: LifecycleEnvelope | null;
  loading: boolean;
  error: string | null;
  /** A refresh failed after a successful read: the data shown is old and says so. */
  stale: boolean;
}
const INITIAL: LifecycleBattleView = { data: null, loading: true, error: null, stale: false };

/**
 * Reads one lifecycle battle and refreshes it. A newer request aborts the one in flight, and a response
 * is applied only if it is still the latest for the same namespace and battle, so a slow old answer can
 * never overwrite a newer one. Failure keeps the last good data flagged stale; it never loads demo data.
 */
export function useLifecycleBattle(namespace: Namespace, battleId: string, refreshMs = 5000): LifecycleBattleView {
  const scope = `${applicationKey(namespace)}:${battleId}`;
  const [state, setState] = useState<{ scope: string; view: LifecycleBattleView }>({ scope, view: INITIAL });
  useEffect(() => {
    setState({ scope, view: INITIAL });
    let latest = 0;
    let controller: AbortController | null = null;
    let timer: number | null = null;
    let stopped = false;
    const load = async () => {
      controller?.abort();
      const mine = ++latest;
      controller = new AbortController();
      try {
        const data = await fetchLifecycleBattle(namespace, battleId, controller.signal);
        if (stopped || mine !== latest) return;
        setState({ scope, view: { data, loading: false, error: null, stale: false } });
      } catch (err) {
        if (stopped || mine !== latest || controller.signal.aborted) return;
        const message = err instanceof LifecycleReadError || err instanceof Error ? err.message : String(err);
        setState((s) => ({ scope, view: { data: s.scope === scope ? s.view.data : null, loading: false, error: message, stale: s.scope === scope && s.view.data !== null } }));
      }
      if (!stopped && mine === latest) timer = window.setTimeout(load, refreshMs);
    };
    void load();
    return () => { stopped = true; latest++; controller?.abort(); if (timer !== null) window.clearTimeout(timer); };
    // The full namespace and battle are encoded in `scope`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, refreshMs]);
  return state.scope === scope ? state.view : INITIAL;
}
