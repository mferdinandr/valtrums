"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { orderAlerts, provenance, type RecoveryAlert, type Sourced } from "@/lib/arena-read/account-state";
import { fetchReadTool } from "@/lib/arena-read/client";

/** Recovery alerts, recomputed by the read API on every poll; a resolved condition disappears. */
export function RecoveryAlerts() {
  const [alerts, setAlerts] = useState<RecoveryAlert[] | null>(null);
  const [meta, setMeta] = useState<Sourced | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // One request at a time: a newer poll aborts an older one so a late response cannot overwrite a newer one.
    let controller: AbortController | null = null;
    const load = async () => {
      controller?.abort();
      const mine = (controller = new AbortController());
      try {
        const env = await fetchReadTool<{ alerts: RecoveryAlert[] }>("list_recovery_alerts", new URLSearchParams(), { signal: mine.signal });
        if (!alive || mine.signal.aborted) return;
        setAlerts(orderAlerts(env.data.alerts));
        setMeta({ source: env.source, observedAt: env.observedAt ?? "" });
        setError(null);
      } catch (e) {
        if (alive && !mine.signal.aborted) setError(e instanceof Error ? e.message : "alerts unavailable");
      }
    };
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      controller?.abort();
      clearInterval(timer);
    };
  }, []);

  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-lg text-neon-green">Recovery alerts</h2>
      {error && (
        <p role="alert" className="text-base text-neon-amber">
          Alerts unavailable: {error}. This is not &quot;no alerts&quot;.
        </p>
      )}
      {alerts && alerts.length === 0 && <p className="text-base text-mute">No active alerts.</p>}
      <ul className="space-y-2">
        {alerts?.map((a) => (
          <li key={a.id} className="text-base">
            <Badge tone={a.severity === "critical" ? "red" : "amber"}>{a.severity}</Badge> <span className="text-mute">{a.subject}</span>{" "}
            {a.message}
          </li>
        ))}
      </ul>
      {meta && <p className="text-sm text-mute">{provenance(meta, Date.now())}</p>}
    </Card>
  );
}
