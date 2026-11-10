import type { LifecycleBattleView, PayoutView, RoundView } from "./read-source.js";

/**
 * Recovery alerts (#79). Each alert is recomputed from current state on every read: it fires
 * while its condition holds and clears as soon as the condition is gone, so there is no stored
 * alert that could go stale. Alert ids are stable per subject so a UI can track them.
 */

export type AlertKind =
  | "audit_missing"
  | "audit_expired"
  | "market_data_missing"
  | "backing_deficit"
  | "backing_suspended"
  | "accounting_unbalanced"
  | "payout_unresolved"
  | "indexer_reconciliation"
  | "indexer_degraded"
  | "indexer_stale";

export type AlertSeverity = "critical" | "warning";

export interface RecoveryAlert {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  subject: string;
  message: string;
}

/** `backing.get_suspension` (subset). */
export interface SuspensionView {
  suspended: boolean;
  reorg: boolean;
  deficit: boolean;
  unresolved: string;
}

/** `backing.get_ledger` (subset). */
export interface LedgerView {
  accounting_balanced: boolean;
  reconciliation_required: boolean;
}

/** Indexer health as persisted by the indexer (`agent/src/indexer`). */
export interface IndexerHealthView {
  status: "healthy" | "pending" | "degraded" | "reconciliation_required";
  reason: string;
  lastSyncMs: number | null;
}

export interface AlertInput {
  nowMs: number;
  battles: { battleId: number; battle: LifecycleBattleView; round: RoundView | null }[];
  backings: { backing: string; suspension: SuspensionView | null; ledger: LedgerView | null }[];
  payouts: PayoutView[];
  indexer: IndexerHealthView | null;
  /** A round with no winner this long after its end is missing market data (default 5 minutes). */
  marketGraceMs?: number;
  /** An indexer that has not synced for this long is stale (default 10 minutes). */
  indexerStaleMs?: number;
}

const NS_PER_MS = 1_000_000n;

export function evaluateAlerts(input: AlertInput): RecoveryAlert[] {
  const alerts: RecoveryAlert[] = [];
  const add = (kind: AlertKind, severity: AlertSeverity, subject: string, message: string) =>
    alerts.push({ id: `${kind}:${subject}`, kind, severity, subject, message });

  for (const { battleId, battle, round } of input.battles) {
    if (!battle.locked) {
      battle.communities.forEach((c, i) => {
        const subject = `battle:${battleId}:community:${i}`;
        if (!c.audit_evidence_hash) add("audit_missing", "warning", subject, "no passing audit; deposits stay closed for this community");
        else if (!c.audit_expires_at_ms || BigInt(c.audit_expires_at_ms) <= BigInt(input.nowMs)) {
          add("audit_expired", "warning", subject, "the audit approval expired; the battle cannot lock until it is refreshed");
        }
      });
    }
    if (battle.locked && battle.principal_community === null && round?.end_ns && round.winner === null) {
      const overdue = BigInt(round.end_ns) + BigInt(input.marketGraceMs ?? 300_000) * NS_PER_MS;
      if (BigInt(input.nowMs) * NS_PER_MS > overdue) {
        add("market_data_missing", "critical", `battle:${battleId}:round:${round.round_id}`, "the round ended without complete market data; it stays pending");
      }
    }
  }

  for (const { backing, suspension, ledger } of input.backings) {
    const subject = `backing:${backing}`;
    if (suspension?.deficit) add("backing_deficit", "critical", subject, "custody is below the recorded liabilities; transfers are suspended");
    else if (suspension?.suspended || suspension?.reorg) add("backing_suspended", "critical", subject, "the backing is suspended pending reconciliation");
    if (ledger && (!ledger.accounting_balanced || ledger.reconciliation_required)) {
      add("accounting_unbalanced", "critical", subject, "the backing ledger needs reconciliation");
    }
  }

  for (const p of input.payouts) {
    if (p.state === "ReconciliationRequired" || p.state === "Reverted") {
      const id = Array.isArray(p.request_id) ? Buffer.from(p.request_id).toString("hex").slice(0, 16) : String(p.request_id);
      add("payout_unresolved", "critical", `payout:${p.backing}:${p.holder}:${id}`, `payout is ${p.state === "Reverted" ? "reverted" : "awaiting reconciliation"}; it is not paid`);
    }
  }

  const idx = input.indexer;
  if (idx) {
    if (idx.status === "reconciliation_required") add("indexer_reconciliation", "critical", "indexer", `indexer needs reconciliation: ${idx.reason}`);
    else if (idx.status === "degraded") add("indexer_degraded", "warning", "indexer", `indexer is degraded: ${idx.reason}`);
    if (idx.lastSyncMs === null || input.nowMs - idx.lastSyncMs > (input.indexerStaleMs ?? 600_000)) {
      add("indexer_stale", "warning", "indexer", "the indexer has not synced recently; displayed history may be behind");
    }
  }
  return alerts;
}
