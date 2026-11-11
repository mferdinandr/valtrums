"use client";

import { useEffect, useRef, useState } from "react";
import { applicationKey, type Namespace } from "@/lib/arena-read/application";
import { createObservationPoller, fetchObservations, type ObservationView } from "@/lib/arena-read/observations";

const INITIAL: ObservationView = { state: "loading", items: [], latest: null, stale: false, partial: false, reconciledAtRevision: null, error: null };

/**
 * Cancel-safe observation polling for one battle. The poller (not this hook) rejects stale and foreign
 * responses; changing the namespace or battle discards the previous view first. Hiding the tab pauses
 * only these display refreshes: backend collection and scheduling never depended on the browser.
 */
export function useObservationChart(namespace: Namespace, battleId: string, enabled: boolean): ObservationView {
  const scope = `${applicationKey(namespace)}:${battleId}`;
  const [state, setState] = useState<{ scope: string; view: ObservationView }>({ scope, view: INITIAL });
  const namespaceRef = useRef(namespace);
  namespaceRef.current = namespace;
  useEffect(() => {
    setState({ scope, view: INITIAL });
    if (!enabled) return;
    const poller = createObservationPoller({
      fetcher: (params, signal) => fetchObservations(namespaceRef.current, battleId, params, signal),
      onView: (view) => setState({ scope, view }),
      // The collector writes one sample per second; poll as often so the chart advances every second.
      intervalMs: 1000,
    });
    const onVisibility = () => poller.setPaused(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    poller.start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      poller.cancel();
    };
  }, [scope, battleId, enabled]);
  return state.scope === scope ? state.view : INITIAL;
}
