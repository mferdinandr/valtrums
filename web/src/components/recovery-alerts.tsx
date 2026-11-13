"use client";

import { useEffect, useState } from "react";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { orderAlerts, type RecoveryAlert } from "@/lib/arena-read/account-state";
import { fetchReadTool } from "@/lib/arena-read/client";

const SHOWN = 3;

/** "battle:1:community:0" becomes "Battle #1 · crew 1"; any other subject is shown as it is. */
function readableSubject(subject: string): string {
  const m = /^battle:(\d+):community:(\d+)$/.exec(subject);
  return m ? `Battle #${m[1]} · crew ${Number(m[2]) + 1}` : subject;
}

/** Recovery alerts, recomputed by the read API on every poll; a resolved condition disappears. */
export function RecoveryAlerts() {
  const [alerts, setAlerts] = useState<RecoveryAlert[] | null>(null);
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
      {!alerts && !error && (
        <SkeletonGroup label="Checking for alerts…" className="space-y-3">
          {[220, 260, 200].map((w, i) => <Skeleton key={i} style={{ width: w, height: 16 }} />)}
        </SkeletonGroup>
      )}
      {error && (
        <p role="alert" className="text-base text-neon-amber">
          Alerts unavailable: {error}. This is not &quot;no alerts&quot;.
        </p>
      )}
      {alerts && alerts.length === 0 && <p className="text-base text-mute">No active alerts.</p>}
      <ul className="space-y-2">
        {alerts?.slice(0, SHOWN).map((a) => (
          <li key={a.id} className="text-base">
            <Badge tone={a.severity === "critical" ? "red" : "amber"}>{a.severity === "critical" ? "Needs action" : "Heads up"}</Badge>{" "}
            <span className="text-mute">{readableSubject(a.subject)}</span> {a.message}
          </li>
        ))}
      </ul>
      {alerts && alerts.length > SHOWN && (
        <details className="lifecycle-tech">
          <summary>Show {alerts.length - SHOWN} more</summary>
          <ul className="space-y-2">
            {alerts.slice(SHOWN).map((a) => (
              <li key={a.id} className="text-base">
                <span className="text-mute">{readableSubject(a.subject)}</span> {a.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
