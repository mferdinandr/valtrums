import type { Db } from "../hosted/db.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_RECORDS,
  JOURNAL_GENESIS,
  MAX_LINE_BYTES,
  ObservationCapacityError,
  ObservationConflictError,
  ObservationCorruptError,
  ObservationLockedError,
  ObservationState,
  ObservationValidationError,
  journalLineHash,
  verifyAndApply,
  type AppendResult,
  type JournalHealth,
  type JournalLine,
  type JournalOptions,
} from "../observations/journal.js";
import {
  namespaceKey,
  observationId,
  observationSchema,
  retractionSchema,
  slotKey,
  type Observation,
  type ObservationNamespace,
  type Retraction,
} from "../observations/schema.js";
import { tryAdvisoryLock, type LockSession } from "./pg-session.js";

/**
 * The observation journal in Postgres (OpenSpec `observation-journal-database`), with the file journal's guarantees:
 * one hash chain per namespace from the same genesis, verified by the same code (`verifyAndApply`); append-only rows
 * (database triggers); one writer (a session advisory lock instead of `journal.lock`); a record acknowledged and
 * visible only after its transaction committed (instead of fsync plus manifest); deduplication, slot conflicts,
 * retractions that never erase, and a visible capacity limit with nothing pruned. A head row written in the same
 * transaction as each record replaces the manifest; unlike the manifest it never lags, so any disagreement with the
 * rows is corruption.
 */

const PAGE = 1_000;
const lockName = (ns: string) => `observation-journal:${ns}`;

interface Row {
  seq: string | number;
  kind: "observation" | "retraction";
  body: unknown;
  prev_hash: string;
  hash: string;
  observation_id: string | null;
  slot_key: string | null;
  retracts: string | null;
}

const toLine = (r: Row): JournalLine => ({ seq: Number(r.seq), kind: r.kind, body: r.body, prev: r.prev_hash, hash: r.hash });
export const lineBytes = (line: JournalLine): number => Buffer.byteLength(`${JSON.stringify(line)}\n`);

/** The derived, indexed columns of a record; recomputed from the body, never trusted from a row. */
export function derivedColumns(line: JournalLine): { observation_id: string | null; slot_key: string | null; retracts: string | null; battle_id: string | null; round_id: string | null } {
  if (line.kind === "observation") {
    const o = observationSchema.parse(line.body);
    return { observation_id: observationId(o), slot_key: slotKey(o), retracts: null, battle_id: o.battleId, round_id: o.roundId };
  }
  const r = retractionSchema.parse(line.body);
  return { observation_id: null, slot_key: null, retracts: r.observationId, battle_id: null, round_id: null };
}

const corrupt = (reason: string) => new ObservationCorruptError(reason);

/**
 * Brings `state` up to the namespace's head: reads the head and every row after `state`'s head in one repeatable-read
 * snapshot, verifies each link and its indexed columns, and refuses a head that disagrees with the rows (rows missing
 * before it, rows beyond it, or another hash). Throws ObservationCorruptError; a connection error is thrown as is.
 */
export async function catchUp(db: Db, ns: string, state: ObservationState): Promise<{ bytes: number }> {
  return db.transaction(async (tx) => {
    await tx.query("set transaction isolation level repeatable read");
    const head = (await tx.query<{ seq: string | number; head_hash: string; bytes: string | number }>(
      "select seq, head_hash, bytes from public.observation_journal_head where namespace_key = $1",
      [ns],
    )).rows[0];
    const headSeq = head ? Number(head.seq) : 0;
    const headHash = head?.head_hash ?? JOURNAL_GENESIS;
    if (headSeq < state.head.seq) throw corrupt("the journal head is behind records already read");
    while (state.head.seq < headSeq) {
      const { rows } = await tx.query<Row>(
        `select seq, kind, body, prev_hash, hash, observation_id, slot_key, retracts from public.observation_journal
         where namespace_key = $1 and seq > $2 and seq <= $3 order by seq limit $4`,
        [ns, state.head.seq, headSeq, PAGE],
      );
      if (rows.length === 0) throw corrupt(`records missing before the journal head (after record ${state.head.seq})`);
      for (const row of rows) {
        const line = toLine(row);
        verifyAndApply(state, line);
        const d = derivedColumns(line);
        if (d.observation_id !== row.observation_id || d.slot_key !== row.slot_key || d.retracts !== row.retracts) {
          throw corrupt(`record ${line.seq} has index columns that do not match its body`);
        }
      }
    }
    const beyond = await tx.query("select 1 from public.observation_journal where namespace_key = $1 and seq > $2 limit 1", [ns, headSeq]);
    if (beyond.rows.length > 0) throw corrupt("records exist beyond the journal head");
    if (state.head.headHash !== headHash) throw corrupt("the journal head does not match the hash chain");
    return { bytes: head ? Number(head.bytes) : 0 };
  });
}

/**
 * Read side for the oracle and the read API: a full verified load on first use, then only the rows after the head it
 * holds. Calls are serialized. Corruption is sticky (every later call throws it; nothing is reset or skipped); a
 * connection error is thrown for that call only, never returned as an empty state.
 */
export class PgObservationReader {
  private readonly state = new ObservationState();
  private corruption: Error | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly ns: string;

  constructor(private readonly db: Db, namespace: ObservationNamespace) {
    this.ns = namespaceKey(namespace);
  }

  load(): Promise<ObservationState> {
    const run = this.chain.then(async () => {
      if (this.corruption) throw this.corruption;
      try {
        await catchUp(this.db, this.ns, this.state);
      } catch (err) {
        if (err instanceof ObservationCorruptError) this.corruption = err;
        throw err;
      }
      return this.state;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}

export interface PgJournalDeps {
  db: Db;
  /** Dedicated connection that holds the writer lock for the journal's life; closed by `close()`. */
  session: LockSession;
  namespace: ObservationNamespace;
}

export class PgObservationJournal {
  private writing: Promise<unknown> = Promise.resolve();
  private readonly reasons = new Set<string>();
  private closed = false;
  /** Set when a write's outcome is unknown (the commit may have landed); the next job re-reads the head first. */
  private needsSync = false;

  private constructor(
    private readonly deps: PgJournalDeps,
    private readonly ns: string,
    readonly state: ObservationState,
    private bytes: number,
    private readonly maxRecords: number,
    private readonly maxBytes: number,
  ) {}

  /** Takes the writer lock and loads the verified journal. Throws ObservationLockedError / ObservationCorruptError. */
  static async open(deps: PgJournalDeps, opts: JournalOptions = {}): Promise<PgObservationJournal> {
    const ns = namespaceKey(deps.namespace);
    try {
      if (!(await tryAdvisoryLock(deps.session, lockName(ns)))) throw new ObservationLockedError();
      const state = new ObservationState();
      const { bytes } = await catchUp(deps.db, ns, state);
      return new PgObservationJournal(deps, ns, state, bytes, opts.maxRecords ?? DEFAULT_MAX_RECORDS, opts.maxBytes ?? DEFAULT_MAX_BYTES);
    } catch (err) {
      await deps.session.close().catch(() => undefined);
      throw err;
    }
  }

  health(): JournalHealth {
    return { status: this.reasons.size === 0 ? "healthy" : "degraded", reasons: [...this.reasons].sort() };
  }

  /** Releases the writer lock after the pending write. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writing.catch(() => undefined);
    await this.deps.session.close().catch(() => undefined);
  }

  /** Validates, deduplicates and persists one observation. Resolves only after the record committed. */
  append(input: unknown): Promise<AppendResult> {
    const parsed = observationSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new ObservationValidationError(parsed.error.issues[0]?.message ?? "invalid"));
    const o = parsed.data;
    if (namespaceKey(o.namespace) !== this.ns) return Promise.reject(new ObservationValidationError("the observation belongs to another namespace than this journal"));
    return this.enqueue(async () => {
      const id = observationId(o);
      const existing = this.state.byId.get(id);
      if (existing) return { status: "duplicate", seq: existing.seq, id };
      if (this.state.bySlot.has(slotKey(o))) {
        this.reasons.add("conflicting_source_evidence");
        throw new ObservationConflictError(slotKey(o));
      }
      const seq = await this.write("observation", o);
      return { status: "created", seq, id };
    });
  }

  /** Marks an observation of this namespace as retracted. Idempotent. */
  retract(input: Retraction): Promise<{ status: "created" | "duplicate"; seq: number }> {
    const parsed = retractionSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new ObservationValidationError(parsed.error.issues[0]?.message ?? "invalid"));
    const r = parsed.data;
    return this.enqueue(async () => {
      const target = this.state.byId.get(r.observationId);
      if (namespaceKey(r.namespace) !== this.ns || !target) throw new ObservationValidationError("retraction names an unknown observation");
      const done = this.state.retracted.get(r.observationId);
      if (done) return { status: "duplicate", seq: done.seq };
      const seq = await this.write("retraction", r);
      return { status: "created", seq };
    });
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("observation journal is closed"));
    const guarded = async () => {
      if (this.needsSync) {
        // Only this writer appends (it holds the lock), so newer verified rows are its own unacknowledged commits.
        const { bytes } = await catchUp(this.deps.db, this.ns, this.state);
        this.bytes = bytes;
        this.needsSync = false;
        // The writer agrees with the database again; a write that failed is no longer a reason to be degraded.
        this.reasons.delete("database_write_failed");
      }
      return job();
    };
    const run = this.writing.then(guarded, guarded);
    this.writing = run.then(() => undefined, () => undefined);
    return run;
  }

  private async write(kind: "observation" | "retraction", body: Observation | Retraction): Promise<number> {
    const seq = this.state.head.seq + 1;
    const prev = this.state.head.headHash;
    const line: JournalLine = { seq, kind, body, prev, hash: journalLineHash(prev, seq, kind, body) };
    const size = lineBytes(line);
    if (size > MAX_LINE_BYTES) throw new ObservationValidationError("record exceeds the per-record size limit");
    if (seq > this.maxRecords) {
      this.reasons.add("capacity_records");
      throw new ObservationCapacityError("records");
    }
    if (this.bytes + size > this.maxBytes) {
      this.reasons.add("capacity_bytes");
      throw new ObservationCapacityError("bytes");
    }
    const d = derivedColumns(line);
    try {
      await this.deps.db.transaction(async (tx) => {
        const head = (await tx.query<{ seq: string | number; head_hash: string }>(
          "select seq, head_hash from public.observation_journal_head where namespace_key = $1 for update",
          [this.ns],
        )).rows[0];
        if ((head ? Number(head.seq) : 0) !== this.state.head.seq || (head?.head_hash ?? JOURNAL_GENESIS) !== prev) {
          throw corrupt("the journal head moved under the writer: another writer or an edit");
        }
        await tx.query(
          `insert into public.observation_journal
             (namespace_key, seq, kind, body, prev_hash, hash, observation_id, slot_key, retracts, battle_id, round_id, line_bytes)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [this.ns, seq, kind, JSON.stringify(body), prev, line.hash, d.observation_id, d.slot_key, d.retracts, d.battle_id, d.round_id, size],
        );
        await tx.query(
          `insert into public.observation_journal_head (namespace_key, seq, head_hash, bytes) values ($1, $2, $3, $4)
           on conflict (namespace_key) do update set seq = excluded.seq, head_hash = excluded.head_hash, bytes = excluded.bytes, updated_at = now()`,
          [this.ns, seq, line.hash, this.bytes + size],
        );
      });
    } catch (err) {
      if (err instanceof ObservationCorruptError) {
        this.reasons.add("journal_corrupt");
        throw err;
      }
      // The commit may or may not have landed: re-read before the next write instead of guessing.
      this.needsSync = true;
      this.reasons.add("database_write_failed");
      throw err;
    }
    // Committed. Only now does the in-memory state (and so any publisher) see the record.
    verifyAndApply(this.state, line);
    this.bytes += size;
    this.reasons.delete("database_write_failed");
    return seq;
  }
}
