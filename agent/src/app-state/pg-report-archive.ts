import type { Db } from "../hosted/db.js";
import {
  ArchiveConflictError,
  ArchiveCorruptError,
  ArchiveValidationError,
  MAX_OBSERVATIONS,
  assertArchiveIntegrity,
  assertSupportedObservation,
  coreOf,
  observationIdOf,
  sameDecision,
  sha256Hex,
  validateObservationInput,
  type ArchiveObservationInput,
  type ArchivedObservation,
  type PutResult,
  type ReportArchive,
} from "../audit/report-archive.js";

interface Row {
  seq: string | number;
  observation_id: string;
  archived_at: Date | string;
  observation: Record<string, unknown>;
}

/**
 * The audit report archive in Postgres (OpenSpec `app-state-database`). It keeps the file archive's identity rules:
 * an observation id commits to the decision content, the same decision is an idempotent retry that keeps the first
 * timestamps, a different decision under an existing id is refused, and nothing is ever updated or deleted (a trigger
 * enforces that in the database too). Stored rows are re-validated on read, and a bad row is an error, never skipped.
 */
export class PgReportArchive implements ReportArchive {
  private readonly hashFn: (text: string) => string;
  constructor(private readonly db: Db, opts: { hashFn?: (text: string) => string } = {}) {
    this.hashFn = opts.hashFn ?? sha256Hex;
  }

  async put(input: ArchiveObservationInput): Promise<PutResult> {
    validateObservationInput(input);
    const core = coreOf(input);
    const observationId = observationIdOf(core, this.hashFn);
    return this.db.transaction(async (tx) => {
      // Serialize writers so the capacity check and the insert cannot interleave; reads are never blocked.
      await tx.query("select pg_advisory_xact_lock(hashtext('audit_report_observations'))");
      const found = await tx.query<Row>("select seq, observation_id, archived_at, observation from public.audit_report_observations where observation_id = $1", [observationId]);
      if (found.rows[0]) {
        const existing = this.toObservation(found.rows[0]);
        // Same id and same decision content is idempotent; a different one is a collision or tampering.
        if (sameDecision(existing, core)) return { observation: existing, created: false };
        throw new ArchiveConflictError(observationId);
      }
      const count = await tx.query<{ n: number }>("select count(*)::int as n from public.audit_report_observations");
      if ((count.rows[0]?.n ?? 0) >= MAX_OBSERVATIONS) throw new ArchiveValidationError("archive observation limit reached");
      const inserted = await tx.query<Row>(
        `insert into public.audit_report_observations (observation_id, arena, battle_id, community, evidence_hash, provenance, report_schema_version, observation)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning seq, observation_id, archived_at, observation`,
        [observationId, core.domain.arena, core.attribution.battleId, core.attribution.community, core.report.evidenceHash, core.provenance, core.reportSchemaVersion, JSON.stringify(core)],
      );
      return { observation: this.toObservation(inserted.rows[0]!), created: true };
    });
  }

  async snapshot(): Promise<ArchivedObservation[]> {
    const { rows } = await this.db.query<Row>("select seq, observation_id, archived_at, observation from public.audit_report_observations order by seq");
    const observations = rows.map((r) => this.toObservation(r));
    assertArchiveIntegrity(observations, (observations.at(-1)?.seq ?? 0) + 1);
    return observations;
  }

  /** The reports of one arena and battle (optionally one community), in insertion order, read through the index. */
  async forBattle(arena: string, battleId: number, community?: number): Promise<ArchivedObservation[]> {
    const { rows } = await this.db.query<Row>(
      `select seq, observation_id, archived_at, observation from public.audit_report_observations
       where arena = $1 and battle_id = $2 and ($3::int is null or community = $3) order by seq`,
      [arena, battleId, community ?? null],
    );
    return rows.map((r) => this.toObservation(r));
  }

  private toObservation(row: Row): ArchivedObservation {
    const archivedAt = new Date(row.archived_at);
    if (Number.isNaN(archivedAt.getTime())) throw new ArchiveCorruptError("archivedAt is not a valid timestamp");
    return assertSupportedObservation(
      { ...row.observation, observationId: row.observation_id, seq: Number(row.seq), archivedAt: archivedAt.toISOString() },
      this.hashFn,
    );
  }
}
