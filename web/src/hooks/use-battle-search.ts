"use client";

import { useEffect, useRef, useState } from "react";
import { type BattlePage, type ReadEnvelope, fetchBattlePage } from "@/lib/arena-read/client";
import { type SearchController, type SearchInput, createSearchController } from "@/lib/arena-read/search-controller";

export interface BattleSearchState {
  result: ReadEnvelope<BattlePage> | null;
  error: string | null;
  loading: boolean;
}

/**
 * Backend battle search for lists and dropdowns: debounced text, immediate filters, cancellation
 * on change and unmount, and stale responses dropped.
 */
export function useBattleSearch(input: SearchInput, debounceMs = 300): BattleSearchState {
  const [state, setState] = useState<BattleSearchState>({ result: null, error: null, loading: false });
  const controller = useRef<SearchController | null>(null);

  useEffect(() => {
    const c = createSearchController<ReadEnvelope<BattlePage>>({
      debounceMs,
      fetcher: (i, signal) => fetchBattlePage(i, signal),
      onResult: (result) => setState({ result, error: null, loading: false }),
      onError: (error) => setState((s) => ({ ...s, error, loading: false })),
      onLoading: (loading) => setState((s) => ({ ...s, loading })),
    });
    controller.current = c;
    return () => {
      c.cancel();
      controller.current = null;
    };
  }, [debounceMs]);

  const key = JSON.stringify(input);
  useEffect(() => {
    controller.current?.update(JSON.parse(key) as SearchInput);
  }, [key]);

  return state;
}
