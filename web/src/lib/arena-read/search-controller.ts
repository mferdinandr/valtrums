/**
 * Drives a backend search box: text changes are debounced, filter changes run at once, a new
 * request aborts the one in flight, and a response that is no longer the latest is dropped even if
 * it arrives after the newer one. Framework-free so it can be tested without a DOM.
 */

export interface SearchInput {
  q?: string;
  [filter: string]: string | number | undefined;
}

export interface SearchControllerOptions<T> {
  fetcher: (input: SearchInput, signal: AbortSignal) => Promise<T>;
  onResult: (result: T, input: SearchInput) => void;
  onError?: (message: string, input: SearchInput) => void;
  onLoading?: (loading: boolean) => void;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SearchController {
  update(input: SearchInput): void;
  /** Cancels any pending debounce and in-flight request; later responses are ignored. */
  cancel(): void;
}

const sameFilters = (a: SearchInput, b: SearchInput): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete("q");
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
};

export function createSearchController<T>(opts: SearchControllerOptions<T>): SearchController {
  const debounceMs = opts.debounceMs ?? 300;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let inflight: AbortController | null = null;
  let seq = 0;
  let last: SearchInput | null = null;

  const run = (input: SearchInput) => {
    timer = null;
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;
    const id = ++seq;
    opts.onLoading?.(true);
    opts.fetcher(input, controller.signal).then(
      (result) => {
        if (id !== seq || controller.signal.aborted) return; // stale
        inflight = null;
        opts.onLoading?.(false);
        opts.onResult(result, input);
      },
      (err: unknown) => {
        if (id !== seq || controller.signal.aborted) return; // cancelled or superseded
        inflight = null;
        opts.onLoading?.(false);
        opts.onError?.(err instanceof Error ? err.message : String(err), input);
      },
    );
  };

  return {
    update(input) {
      const normalized: SearchInput = { ...input, q: (input.q ?? "").trim() };
      const textOnly = last !== null && sameFilters(last, normalized);
      if (last !== null && textOnly && last.q === normalized.q) return; // nothing changed
      last = normalized;
      if (timer !== null) clearTimer(timer);
      if (textOnly) timer = setTimer(() => run(normalized), debounceMs);
      else run(normalized);
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      seq++;
      inflight?.abort();
      inflight = null;
      opts.onLoading?.(false);
    },
  };
}
