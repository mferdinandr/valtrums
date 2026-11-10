"use client";

import { useEffect, useRef, useState } from "react";
import { applicationKey, fetchApplication, type ApplicationEnvelope, type Namespace } from "@/lib/arena-read/application";
import { createSearchController, type SearchController, type SearchInput } from "@/lib/arena-read/search-controller";

/** Shared by battle lists and trusted asset dropdowns. Namespace changes discard prior data. */
export function useApplicationSearch<T>(namespace: Namespace, resource: "battles" | "assets", input: SearchInput) {
  const scope = `${applicationKey(namespace)}:${resource}`;
  const [state, setState] = useState<{ scope: string; result: ApplicationEnvelope<T> | null; loading: boolean; error: string | null }>({ scope, result: null, loading: true, error: null });
  const controller = useRef<SearchController | null>(null);
  const key = JSON.stringify(input);
  useEffect(() => {
    setState({ scope, result: null, loading: true, error: null });
    const c = createSearchController<ApplicationEnvelope<T>>({
      fetcher: (i, signal) => fetchApplication<T>(namespace, resource, i, signal),
      onResult: (result) => setState({ scope, result, loading: false, error: null }),
      onError: (error) => setState((s) => ({ ...s, loading: false, error })),
      onLoading: (loading) => setState((s) => ({ ...s, loading })),
    });
    controller.current = c;
    return () => { c.cancel(); controller.current = null; };
    // The full namespace and resource are encoded in scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  useEffect(() => { controller.current?.update(JSON.parse(key) as SearchInput); }, [scope, key]);
  return state.scope === scope ? state : { scope, result: null, loading: true, error: null };
}
