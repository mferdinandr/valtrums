"use client";

import { useEffect, useState } from "react";
import { useArena } from "@/components/providers";
import type { TokenMeta } from "@/lib/arena/types";

/** Fallback shown until metadata resolves. */
export function fallbackMeta(id: string): TokenMeta {
  return { id, symbol: (id.split(".")[0] ?? id).toUpperCase(), decimals: 18 };
}

/** Resolves NEP-148 metadata for a set of token ids. */
export function useTokenMetas(ids: readonly string[]): Record<string, TokenMeta> {
  const api = useArena();
  const [metas, setMetas] = useState<Record<string, TokenMeta>>({});
  const key = [...new Set(ids)].sort().join(",");

  useEffect(() => {
    let cancelled = false;
    const wanted = key ? key.split(",") : [];
    void Promise.all(wanted.map((id) => api.getTokenMeta(id).catch(() => fallbackMeta(id)))).then((list) => {
      if (cancelled) return;
      setMetas(Object.fromEntries(list.map((m) => [m.id, m])));
    });
    return () => {
      cancelled = true;
    };
  }, [api, key]);

  return new Proxy(metas, {
    get: (target, prop: string) => target[prop] ?? fallbackMeta(prop),
  });
}
