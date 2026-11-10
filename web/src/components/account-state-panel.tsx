"use client";

import { Card } from "@/components/ui/card";
import { type AccountStateData, type Row, describeAccountState } from "@/lib/arena-read/account-state";
import type { Part } from "@/hooks/use-portfolio";
import { envelopeLabel } from "@/lib/arena-read/portfolio";

export function Section({ title, rows, empty }: { title: string; rows: Row[]; empty: string }) {
  return (
    <div className="space-y-2">
      <h3 className="text-base text-neon-cyan">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-base text-mute">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.key} className="text-base">
              <div className="break-all">
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
 * Backing entitlements and DAO principal for the connected account. The data arrives through the wallet session
 * (see `usePortfolio`); this panel holds no token and reads nothing itself. The D22/D24/D28 disposition state is
 * shown as the read service reports it; nothing here votes or releases.
 */
export function AccountStatePanel({ part, nowMs }: { part: Part<AccountStateData>; nowMs: number }) {
  if (part.state === "error") {
    return (
      <Card role="alert" className="space-y-2 p-4">
        <h2 className="text-lg text-neon-green">Entitlements and DAO principal</h2>
        <p className="text-base text-neon-amber">Could not be read: {part.message}. Nothing is assumed about your entitlements or principal.</p>
      </Card>
    );
  }
  const view = describeAccountState(part.env.data, nowMs);
  return (
    <Card className="space-y-4 p-4">
      <h2 className="text-lg text-neon-green">Entitlements and DAO principal</h2>
      <p className="text-sm text-mute">{envelopeLabel(part.env, nowMs)}</p>
      <Section
        title="Entitlements reported by each backing (claimable, not transferred)"
        rows={view.entitlements}
        empty="No positive entitlement was reported for the inspected battles. This is not a confirmed zero for every asset."
      />
      <Section title="DAO principal (escrowed winning deposit)" rows={view.dao} empty="No winning principal in escrow was found in the inspected battles." />
      {part.env.limitations.length > 0 && (
        <ul className="list-disc pl-4 text-sm text-mute">
          {part.env.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
