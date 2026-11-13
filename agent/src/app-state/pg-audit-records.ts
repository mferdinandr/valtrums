import type { Db } from "../hosted/db.js";
import type { AuditRecord } from "../audit/decision.js";

/**
 * The agent's latest audit decision per lifecycle community, in Postgres (`public.lifecycle_audit_records`), so a
 * restart does not re-audit every open battle and delay a lock. Rows are scoped to one arena contract, because battle
 * ids repeat across deployments that share a database.
 *
 * It is a cache, never an authority: a row is written only after the arena accepted the matching submission, the
 * caller re-validates every loaded record against the current asset, policy and expiry before relying on it, and the
 * arena re-checks every approval at lock. So a malformed row is skipped (that community is simply audited again)
 * instead of stopping the agent.
 */

/** A decision is useless once its approval (or, for a non-pass, its retry backoff) is this far behind. */
export const AUDIT_RECORD_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Rows loaded at start at most; the newest decisions win. */
export const MAX_LOADED_AUDIT_RECORDS = 5_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The fields the audit pass relies on; anything else in the record is carried through unchanged. */
function asAuditRecord(value: unknown): AuditRecord | null {
  if (!isObject(value) || !isObject(value.asset)) return null;
  if (typeof value.result !== "string" || typeof value.policyHash !== "string" || typeof value.evidenceHash !== "string") return null;
  if (typeof value.decidedAt !== "string" || !Number.isFinite(Date.parse(value.decidedAt))) return null;
  if (value.expiresAt !== null && (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)))) return null;
  return value as unknown as AuditRecord;
}

export interface LoadedAuditRecords {
  /** Keyed `${battleId}:${community}`, the key the audit pass uses. */
  records: Map<string, AuditRecord>;
  /** Rows whose record did not have the expected shape; they were left in place and not loaded. */
  skipped: number;
}

export class PgAuditRecordStore {
  constructor(
    private readonly db: Db,
    private readonly arena: string,
  ) {
    if (arena.trim().length === 0) throw new Error("the audit record store needs the arena contract id");
  }

  /** Removes long-expired rows of this arena, then loads the rest. */
  async load(now: Date = new Date()): Promise<LoadedAuditRecords> {
    const cutoff = new Date(now.getTime() - AUDIT_RECORD_RETENTION_MS).toISOString();
    await this.db.query(
      "delete from public.lifecycle_audit_records where arena = $1 and coalesce(expires_at, decided_at) < $2",
      [this.arena, cutoff],
    );
    const { rows } = await this.db.query<{ battle_id: string | number; community: number; record: unknown }>(
      `select battle_id, community, record from public.lifecycle_audit_records
       where arena = $1 order by decided_at desc limit $2`,
      [this.arena, MAX_LOADED_AUDIT_RECORDS],
    );
    const records = new Map<string, AuditRecord>();
    let skipped = 0;
    for (const row of rows) {
      const record = asAuditRecord(row.record);
      if (!record) {
        skipped++;
        continue;
      }
      records.set(`${Number(row.battle_id)}:${row.community}`, record);
    }
    return { records, skipped };
  }

  /** Stores the latest decision for one community, replacing the previous one. */
  async put(battleId: number, community: number, record: AuditRecord): Promise<void> {
    if (!Number.isSafeInteger(battleId) || battleId < 0 || !Number.isSafeInteger(community) || community < 0) {
      throw new Error("audit record key must be non-negative integers");
    }
    await this.db.query(
      `insert into public.lifecycle_audit_records (arena, battle_id, community, result, expires_at, decided_at, record)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (arena, battle_id, community) do update set
         result = excluded.result, expires_at = excluded.expires_at, decided_at = excluded.decided_at,
         record = excluded.record, updated_at = now()`,
      [this.arena, battleId, community, record.result, record.expiresAt, record.decidedAt, JSON.stringify(record)],
    );
  }
}
