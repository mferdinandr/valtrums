"use client";

import { useCallback, useState } from "react";

export interface ActionState {
  busy: boolean;
  error: string | null;
  run: (fn: () => Promise<void>) => Promise<boolean>;
  clearError: () => void;
}

/** Wraps a user-triggered async action with busy and error state. Resolves true on success. */
export function useAction(): ActionState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  const clearError = useCallback(() => setError(null), []);
  return { busy, error, run, clearError };
}
