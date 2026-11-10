"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { type AccountStateData, type Row, describeAccountState } from "@/lib/arena-read/account-state";
import { fetchReadTool } from "@/lib/arena-read/client";

const STORAGE_KEY = "valtrum.read-session";

function Section({ title, rows, empty }: { title: string; rows: Row[]; empty: string }) {
  return (
    <div className="space-y-2">
      <h3 className="text-base text-neon-cyan">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-base text-mute">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.key} className="text-base">
              <div>
                {r.title}: <span className="text-neon-green">{r.status}</span>
              </div>
              <div className="text-mute">{r.detail}</div>
              <div className="text-sm text-mute">{r.provenance}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Entitlements, transfers and DAO principal for one account, each section separate and every row
 * with its source and freshness. Reads need a read session (`open_read_session`, NEP-413); the
 * token stays in this tab's session storage and grants no signing or spending authority.
 */
export function AccountStatePanel() {
  const [token, setToken] = useState("");
  const [data, setData] = useState<AccountStateData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      setToken(sessionStorage.getItem(STORAGE_KEY) ?? "");
    } catch {
      // Storage can be unavailable; the panel still works for this render.
    }
  }, []);

  const load = async () => {
    try {
      sessionStorage.setItem(STORAGE_KEY, token);
    } catch {
      // Ignore unavailable storage.
    }
    try {
      const env = await fetchReadTool<AccountStateData>("inspect_account_state", new URLSearchParams(), { session: token.trim() });
      setData(env.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "account state unavailable");
    }
  };

  const view = data ? describeAccountState(data, Date.now()) : null;
  return (
    <Card className="space-y-4 p-4">
      <h2 className="text-lg text-neon-green">Entitlements, transfers and DAO principal</h2>
      <div className="flex gap-2">
        <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Read session token (open_read_session)" />
        <Button onClick={() => void load()} disabled={!token.trim()}>
          Load
        </Button>
      </div>
      {error && <p className="text-base text-mute">{error}</p>}
      {view && (
        <>
          <Section title="Entitlements (claimable, not transferred)" rows={view.entitlements} empty="No available entitlement." />
          <Section title="Transfers (paid only when confirmed)" rows={view.transfers} empty="No open payout transfer." />
          <Section title="DAO principal (escrowed winning deposit)" rows={view.dao} empty="No winning principal in escrow." />
        </>
      )}
    </Card>
  );
}
