"use client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { PortfolioData, Part, PayoutsData } from "@/hooks/use-portfolio";
import {
  describePayouts,
  emptyPayoutsText,
  entitlementAvailability,
  envelopeLabel,
  historyNote,
  normalizePositions,
} from "@/lib/arena-read/portfolio";

function Failed({ title, message }: { title: string; message: string }) {
  return (
    <Card role="alert" className="space-y-2 p-4">
      <h2 className="text-lg text-neon-green">{title}</h2>
      <p className="text-base text-neon-amber">This section is unavailable. Please try again.</p>
      <details className="lifecycle-tech"><summary>Details</summary><p>{message}</p></details>
    </Card>
  );
}

function Limits({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="list-disc pl-4 text-sm text-mute">
      {items.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

/** Deposits per battle and community, grouped by original asset. Amounts are exact; assets are never added together. */
export function PositionsSection({ part, nowMs }: { part: PortfolioData["positions"]; nowMs: number }) {
  if (part.state === "error") return <Failed title="Positions" message={part.message} />;
  const groups = normalizePositions(part.env.data);
  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-lg text-neon-green">Your positions</h2>
      <p className="text-sm text-mute">{envelopeLabel(part.env, nowMs)}</p>
      {groups.length === 0 ? (
        <p className="text-base text-mute">No positions found in recent battles. Older battles are not scanned yet.</p>
      ) : (
        groups.map((g) => (
          <div key={g.asset} className="space-y-1">
            <h3 className="break-all text-base text-neon-cyan">{g.asset}</h3>
            <ul className="space-y-1 text-base">
              {g.rows.map((r) => (
                <li key={r.key} className="break-all">
                  Battle #{r.battleId} / community {r.community + 1}: <span className="text-neon-green">{r.amount}</span> base units
                  {!r.valid && <Badge tone="red"> malformed amount</Badge>}
                </li>
              ))}
            </ul>
            <p className="text-sm text-mute">Total for this asset: {g.subtotal ?? "unavailable"} base units</p>
          </div>
        ))
      )}
      <Limits items={part.env.limitations} />
    </Card>
  );
}

/** Per-account entitlements: the read tool states it is not available from the contract yet. Never rendered as 0. */
export function EntitlementAvailabilitySection({ part, nowMs }: { part: PortfolioData["entitlements"]; nowMs: number }) {
  if (part.state === "error") return <Failed title="Per-account entitlements" message={part.message} />;
  const a = entitlementAvailability(part.env.data, part.env.limitations);
  return (
    <Card className="space-y-2 p-4">
      <h2 className="text-lg text-neon-green">Rewards</h2>
      <p className="text-sm text-mute">{envelopeLabel(part.env, nowMs)}</p>
      {!a.available && (
        <div role="status" className="space-y-1">
          <Badge tone="amber">Status unavailable</Badge>
          <p className="text-base text-mute">We can’t check these rewards yet. Your balance is not necessarily zero.</p>
          <details className="lifecycle-tech"><summary>Details</summary><p>{a.reason}</p></details>
        </div>
      )}
    </Card>
  );
}

/** Payout transfers by stage. Only a confirmed receipt is paid; the list can be incomplete and says so. */
export function TransfersSection({ part, nowMs }: { part: Part<PayoutsData>; nowMs: number }) {
  if (part.state === "error") return <Failed title="Transfers" message={part.message} />;
  const rows = describePayouts(part.env.data.payouts);
  const note = historyNote(part.env.limitations);
  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-lg text-neon-green">Transfers</h2>
      <p className="text-sm text-mute">A transfer is paid when confirmed.</p>
      <p className="text-sm text-mute">{envelopeLabel(part.env, nowMs)}</p>
      {rows.length === 0 ? (
        <p role="status" className="text-base text-mute">
          {emptyPayoutsText(note)}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.key} className="text-base">
              <div className="break-all">
                {r.amount} base units from {r.backing}: <span className={r.paid ? "text-neon-green" : "text-neon-amber"}>{r.label}</span>
              </div>
              <div className="text-mute">{r.detail}</div>
            </li>
          ))}
        </ul>
      )}
      {!note.complete && (
        <div role="status" className="space-y-1">
          <Badge tone="amber">history incomplete</Badge>
          <Limits items={note.notes} />
        </div>
      )}
      <Limits items={part.env.limitations.filter((l) => !note.notes.includes(l))} />
    </Card>
  );
}

/** No read tool reports late funds or refunds yet. Say so instead of showing an empty list. */
export function LateFundsSection() {
  return (
    <Card role="status" className="space-y-2 p-4">
      <h2 className="text-lg text-neon-green">Late funds and refunds</h2>
      <Badge tone="amber">Status unavailable</Badge>
      <p className="text-base text-mute">
        Deposits received after a battle locks are returned and do not join the battle. Refund status is currently unavailable here.
      </p>
    </Card>
  );
}
