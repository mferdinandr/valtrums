/**
 * Display model for the account state and recovery alerts (#79). Entitlements, transfers and DAO
 * principal stay in separate sections; every row names its source and when it was observed. A
 * transfer is "paid" only in its confirmed stage, and a DAO burn only once its sink transfer is
 * confirmed. Pure functions so every state is unit-tested without a browser.
 */

export interface Sourced {
  source: { kind: "live" | "recorded" | "fixture"; name: string };
  observedAt: string;
}

export interface AccountStateData {
  accountId: string;
  entitlements: (Sourced & { backing: string; available: string })[];
  transfers: (Sourced & { backing: string; amount: string; state: string; displayState: string; label: string })[];
  daoPrincipal: (Sourced & {
    battleId: number;
    community: number;
    position: string;
    voteStatus: string;
    voteClosesAtNs: string | null;
    myReturn: { amount: string; recorded: boolean } | null;
    escrow: { escrowed: string; returned: string; burn_pending: string; burn_confirmed: string; still_escrowed: string } | null;
  })[];
}

export interface RecoveryAlert {
  id: string;
  kind: string;
  severity: "critical" | "warning";
  subject: string;
  message: string;
}

export interface Row {
  key: string;
  title: string;
  status: string;
  detail: string;
  provenance: string;
}

const VOTE_LABELS: Record<string, string> = {
  no_winner: "No final winner yet",
  no_vote: "No vote for this battle: principal stays escrowed",
  voting: "Vote open",
  undecided_escrowed: "Vote closed without votes: principal stays escrowed",
  decided: "Decided",
  unknown: "Vote status unavailable",
};

export function provenance(row: Sourced, nowMs: number, maxAgeMs = 60_000): string {
  const age = nowMs - Date.parse(row.observedAt);
  const freshness = Number.isNaN(age) || age < 0 ? "freshness unknown" : age <= maxAgeMs ? "fresh" : "stale";
  const kind = row.source.kind === "fixture" ? "FIXTURE (not live)" : row.source.kind;
  return `${kind} · ${row.source.name} · observed ${row.observedAt} · ${freshness}`;
}

export function describeAccountState(data: AccountStateData, nowMs: number): { entitlements: Row[]; transfers: Row[]; dao: Row[] } {
  return {
    entitlements: data.entitlements.map((e) => ({
      key: `ent:${e.backing}`,
      title: e.backing,
      status: "Entitlement available",
      detail: `${e.available} units claimable; nothing has been transferred yet`,
      provenance: provenance(e, nowMs),
    })),
    transfers: data.transfers.map((t, i) => ({
      key: `tx:${t.backing}:${i}`,
      title: `${t.amount} from ${t.backing}`,
      status: t.displayState === "confirmed" ? "Paid (confirmed)" : t.label,
      detail: t.displayState === "confirmed" ? "finalized receipt verified" : "not paid until its receipt is confirmed",
      provenance: provenance(t, nowMs),
    })),
    dao: data.daoPrincipal.map((d) => {
      const burned = d.escrow?.burn_confirmed ?? "0";
      const pending = d.escrow?.burn_pending ?? "0";
      const parts = [
        `position ${d.position}`,
        d.myReturn ? `your return ${d.myReturn.amount} (${d.myReturn.recorded ? "entitlement recorded" : "not yet released"})` : null,
        d.escrow ? `burn confirmed ${burned}, burn pending ${pending}, still escrowed ${d.escrow.still_escrowed}` : null,
      ].filter(Boolean);
      return {
        key: `dao:${d.battleId}`,
        title: `Battle #${d.battleId} winning principal`,
        status: VOTE_LABELS[d.voteStatus] ?? d.voteStatus,
        detail: parts.join(" · "),
        provenance: provenance(d, nowMs),
      };
    }),
  };
}

/** Critical first, then by id, so the order is stable between refreshes. */
export function orderAlerts(alerts: RecoveryAlert[]): RecoveryAlert[] {
  return [...alerts].sort((a, b) => (a.severity === b.severity ? a.id.localeCompare(b.id) : a.severity === "critical" ? -1 : 1));
}

/** What blocks claiming: a battle whose DAO decision is still running (vote open, or decided with principal left in escrow). */
export function daoBlocksClaim(state: AccountStateData | null): boolean {
  return (state?.daoPrincipal ?? []).some(
    (d) => d.voteStatus === "voting" || (d.voteStatus === "decided" && (d.escrow === null || BigInt(d.escrow.still_escrowed) > 0n)),
  );
}
