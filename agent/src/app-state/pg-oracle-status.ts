import type { Db } from "../hosted/db.js";
import { OracleLockedError, STATUS_SCHEMA, type OracleStatus } from "../lifecycle-oracle/status.js";
import { namespaceKey, type ObservationNamespace } from "../observations/schema.js";
import { tryAdvisoryLock, type LockSession } from "./pg-session.js";

/**
 * The lifecycle oracle's non-authoritative status in Postgres (`public.lifecycle_oracle_status`, OpenSpec
 * `observation-journal-database`), used with OBSERVATION_JOURNAL_STORE=database. One row per namespace, replaced
 * after every pass. A session advisory lock replaces `oracle.lock`: one oracle per namespace, released when its
 * process ends. Losing the row changes nothing on chain; the oracle re-derives everything from the arena and evidence.
 */
const lockName = (ns: string) => `lifecycle-oracle:${ns}`;

export class PgOracleStatusStore {
  private constructor(
    private readonly db: Db,
    private readonly session: LockSession,
    private readonly ns: string,
  ) {}

  /** Takes the single-oracle lock for the namespace; OracleLockedError when another oracle holds it. */
  static async open(deps: { db: Db; session: LockSession; namespace: ObservationNamespace }): Promise<PgOracleStatusStore> {
    const ns = namespaceKey(deps.namespace);
    try {
      if (!(await tryAdvisoryLock(deps.session, lockName(ns)))) throw new OracleLockedError("database");
    } catch (err) {
      await deps.session.close().catch(() => undefined);
      throw err;
    }
    return new PgOracleStatusStore(deps.db, deps.session, ns);
  }

  async write(status: OracleStatus): Promise<void> {
    await this.db.query(
      `insert into public.lifecycle_oracle_status (namespace_key, status) values ($1, $2)
       on conflict (namespace_key) do update set status = excluded.status, updated_at = now()`,
      [this.ns, JSON.stringify(status)],
    );
  }

  /** Releases the single-oracle lock. */
  async close(): Promise<void> {
    await this.session.close().catch(() => undefined);
  }
}

/** Read-only load for the read API. Throws when missing or malformed, like the file status: never reported as healthy. */
export async function loadPgOracleStatus(db: Db, namespace: ObservationNamespace): Promise<OracleStatus> {
  const { rows } = await db.query<{ status: unknown }>("select status from public.lifecycle_oracle_status where namespace_key = $1", [namespaceKey(namespace)]);
  if (!rows[0]) throw new Error("oracle status not found");
  const parsed = rows[0].status as OracleStatus;
  if (parsed?.schema !== STATUS_SCHEMA || typeof parsed.updatedAtMs !== "string" || typeof parsed.battles !== "object") throw new Error("oracle status is malformed");
  return parsed;
}
