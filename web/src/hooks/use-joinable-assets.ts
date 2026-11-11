"use client";

import { useEffect, useState } from "react";
import { config } from "@/lib/config";
import { readJoinableAssets, type JoinableAsset } from "@/lib/arena-read/open-arena";

/** The arena's joinable-token allowlist, read over RPC (no wallet needed). A different arena drops a stale answer. */
export function useJoinableAssets(arena: string) {
  const [state, setState] = useState<{ items: JoinableAsset[] | null; error: string | null }>({ items: null, error: null });
  useEffect(() => {
    let live = true;
    setState({ items: null, error: null });
    readJoinableAssets(config.rpcUrl, arena)
      .then((items) => live && setState({ items, error: null }))
      .catch((e: unknown) => live && setState({ items: null, error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [arena]);
  return state;
}
