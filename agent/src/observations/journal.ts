import { mkdir, open, readFile, rename, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalJson,
  namespaceKey,
  observationId,
  observationSchema,
  retractionSchema,
  sha256Hex,
  slotKey,
  type Observation,
  type ObservationNamespace,
  type Retraction,
} from "./schema.js";

/**
 * Durable observation journal (OpenSpec arena-market-observations, issue #146).
 *
 * Layout: `journal.jsonl` (append-only, one hash-chained record per line), `manifest.json` (atomic
 * temp+rename, written AFTER the journal line is fsynced) and `journal.lock` (single writer, never
 * stolen by age). A record is acknowledged only after its line is durable, so evidence is always
 * persisted before it can be published or submitted. Replay recomputes the hash chain: any edit,
 * reorder or gap is corruption and the journal refuses to open for writing and degrades reads, it is
 * never reset. A torn final line (a crash mid-append, never acknowledged) is the only thing a writer
 * discards, explicitly. The manifest may lag the journal by one record (crash between the two); it
 * may never be ahead of it (that would mean durable evidence was lost). Retraction records mark an
 * earlier observation as no longer valid without erasing it and bump `revision`, so clients know to
 * reload. Nothing here prunes: capacity is finite and reaching it is a visible error.
 */

const GENESIS = "0".repeat(64);
export const JOURNAL_SCHEMA = "observation-journal-v1" as const;
export const DEFAULT_MAX_RECORDS = 200_000;
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
export const MAX_LINE_BYTES = 16 * 1024;

export class ObservationCorruptError extends Error {
  constructor(reason: string) {
    super(`observation journal corrupt: ${reason}`);
    this.name = "ObservationCorruptError";
  }
}
export class ObservationConflictError extends Error {
  constructor(public readonly slot: string) {
    super("an observation with this source evidence slot already exists with different content");
    this.name = "ObservationConflictError";
  }
}
export class ObservationCapacityError extends Error {
  constructor(what: string) {
    super(`observation journal capacity reached (${what}); nothing is pruned`);
    this.name = "ObservationCapacityError";
  }
}
export class ObservationLockedError extends Error {
  constructor() {
    super("observation journal is locked by another writer; stop it and inspect before removing journal.lock");
    this.name = "ObservationLockedError";
  }
}
export class ObservationValidationError extends Error {
  constructor(reason: string) {
    super(`invalid observation: ${reason}`);
    this.name = "ObservationValidationError";
  }
}

export interface StoredObservation {
  seq: number;
  id: string;
  observation: Observation;
}
export interface StoredRetraction {
  seq: number;
  observationId: string;
  reason: string;
  acquiredAtMs: string;
}
export interface Watermark {
  seq: number;
  headHash: string;
}

/** In-memory index rebuilt by replay. Pure data: queries and projections read it, never the disk. */
export class ObservationState {
  readonly observations: StoredObservation[] = [];
  readonly byId = new Map<string, StoredObservation>();
  readonly bySlot = new Map<string, string>();
  readonly retracted = new Map<string, StoredRetraction>();
  head: Watermark = { seq: 0, headHash: GENESIS };

  /** Count of retractions: a client that sees it change must reload its projection. */
  get revision(): number {
    return this.retracted.size;
  }
  isEffective(id: string): boolean {
    return this.byId.has(id) && !this.retracted.has(id);
  }
}

interface Line {
  seq: number;
  kind: "observation" | "retraction";
  body: unknown;
  prev: string;
  hash: string;
}

const lineHash = (prev: string, seq: number, kind: string, body: unknown): string =>
  sha256Hex(prev + canonicalJson({ seq, kind, body }));

function apply(state: ObservationState, line: Line): void {
  if (line.kind === "observation") {
    const parsed = observationSchema.safeParse(line.body);
    if (!parsed.success) throw new ObservationCorruptError(`record ${line.seq} is not a valid observation`);
    const o = parsed.data;
    const id = observationId(o);
    const slot = slotKey(o);
    if (state.byId.has(id) || state.bySlot.has(slot)) throw new ObservationCorruptError(`record ${line.seq} duplicates an earlier observation`);
    const stored = { seq: line.seq, id, observation: o };
    state.observations.push(stored);
    state.byId.set(id, stored);
    state.bySlot.set(slot, id);
  } else if (line.kind === "retraction") {
    const parsed = retractionSchema.safeParse(line.body);
    if (!parsed.success) throw new ObservationCorruptError(`record ${line.seq} is not a valid retraction`);
    const target = state.byId.get(parsed.data.observationId);
    if (!target || namespaceKey(target.observation.namespace) !== namespaceKey(parsed.data.namespace)) {
      throw new ObservationCorruptError(`record ${line.seq} retracts an unknown observation`);
    }
    if (state.retracted.has(parsed.data.observationId)) throw new ObservationCorruptError(`record ${line.seq} repeats a retraction`);
    state.retracted.set(parsed.data.observationId, {
      seq: line.seq,
      observationId: parsed.data.observationId,
      reason: parsed.data.reason,
      acquiredAtMs: parsed.data.acquiredAtMs,
    });
  } else {
    throw new ObservationCorruptError(`record ${line.seq} has an unknown kind`);
  }
  state.head = { seq: line.seq, headHash: line.hash };
}

export interface Replay {
  state: ObservationState;
  /** Bytes of the journal that form complete, verified lines. */
  validBytes: number;
  /** A trailing partial line was found after the last verified one. */
  tornTail: boolean;
  /** Head hash after record N, for checking the manifest. */
  hashAt: Map<number, string>;
}

export function replayJournal(text: string): Replay {
  const state = new ObservationState();
  const hashAt = new Map<number, string>([[0, GENESIS]]);
  let offset = 0;
  let validBytes = 0;
  let prev = GENESIS;
  while (offset < text.length) {
    const nl = text.indexOf("\n", offset);
    if (nl === -1) return { state, validBytes, tornTail: true, hashAt };
    const raw = text.slice(offset, nl);
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      // A complete (newline-terminated) line that is not JSON was not a torn append: it is damage.
      throw new ObservationCorruptError(`line after record ${state.head.seq} is not valid JSON`);
    }
    if (
      !line || typeof line !== "object" || line.seq !== state.head.seq + 1 || line.prev !== prev ||
      typeof line.hash !== "string" || line.hash !== lineHash(prev, line.seq, line.kind, line.body)
    ) {
      throw new ObservationCorruptError(`hash chain broken at record ${state.head.seq + 1}`);
    }
    apply(state, line);
    prev = line.hash;
    hashAt.set(line.seq, line.hash);
    offset = nl + 1;
    validBytes += Buffer.byteLength(raw) + 1;
  }
  return { state, validBytes, tornTail: false, hashAt };
}

interface Manifest {
  schema: typeof JOURNAL_SCHEMA;
  count: number;
  headHash: string;
  bytes: number;
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

async function readManifest(path: string): Promise<Manifest | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let m: Manifest;
  try {
    m = JSON.parse(text) as Manifest;
  } catch {
    throw new ObservationCorruptError("manifest is not valid JSON");
  }
  if (m?.schema !== JOURNAL_SCHEMA || !Number.isSafeInteger(m.count) || m.count < 0 || typeof m.headHash !== "string") {
    throw new ObservationCorruptError("manifest is malformed or has an unsupported schema");
  }
  return m;
}

function checkManifest(replay: Replay, manifest: Manifest | null): void {
  // A journal without a manifest is recoverable: the journal is the truth.
  if (!manifest) return;
  if (manifest.count > replay.state.head.seq) throw new ObservationCorruptError("journal is shorter than its manifest: durable evidence was lost");
  if (replay.hashAt.get(manifest.count) !== manifest.headHash) throw new ObservationCorruptError("manifest does not match the journal's hash chain");
}

export interface SnapshotResult {
  state: ObservationState;
  tornTail: boolean;
  manifestLagging: boolean;
}

/** Read-only replay for the read service. Takes no lock, repairs nothing, throws on corruption. */
export async function loadObservationState(dir: string): Promise<SnapshotResult> {
  const replay = replayJournal(await readText(join(dir, "journal.jsonl")));
  const manifest = await readManifest(join(dir, "manifest.json"));
  checkManifest(replay, manifest);
  return { state: replay.state, tornTail: replay.tornTail, manifestLagging: (manifest?.count ?? 0) < replay.state.head.seq };
}

export interface JournalOptions {
  maxRecords?: number;
  maxBytes?: number;
}
export type AppendResult = { status: "created" | "duplicate"; seq: number; id: string };

export interface JournalHealth {
  status: "healthy" | "degraded";
  reasons: string[];
}

export class ObservationJournal {
  private writing: Promise<unknown> = Promise.resolve();
  private bytes: number;
  private readonly reasons = new Set<string>();
  private closed = false;

  private constructor(
    private readonly dir: string,
    readonly state: ObservationState,
    bytes: number,
    private readonly maxRecords: number,
    private readonly maxBytes: number,
    notes: string[],
  ) {
    this.bytes = bytes;
    for (const n of notes) this.reasons.add(n);
  }

  /** Opens for writing. Throws ObservationCorruptError / ObservationLockedError; never resets state. */
  static async open(dir: string, opts: JournalOptions = {}): Promise<ObservationJournal> {
    await mkdir(dir, { recursive: true });
    const lockPath = join(dir, "journal.lock");
    try {
      const h = await open(lockPath, "wx");
      await h.close();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new ObservationLockedError();
      throw err;
    }
    try {
      const path = join(dir, "journal.jsonl");
      const replay = replayJournal(await readText(path));
      checkManifest(replay, await readManifest(join(dir, "manifest.json")));
      const notes: string[] = [];
      const bytes = replay.validBytes;
      if (replay.tornTail) {
        // An unacknowledged partial append: drop exactly those bytes, and say so.
        await truncate(path, replay.validBytes);
        notes.push("torn_tail_discarded");
      }
      const journal = new ObservationJournal(dir, replay.state, bytes, opts.maxRecords ?? DEFAULT_MAX_RECORDS, opts.maxBytes ?? DEFAULT_MAX_BYTES, notes);
      await journal.writeManifest();
      return journal;
    } catch (err) {
      await unlink(lockPath).catch(() => undefined);
      throw err;
    }
  }

  health(): JournalHealth {
    return { status: this.reasons.size === 0 ? "healthy" : "degraded", reasons: [...this.reasons].sort() };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writing.catch(() => undefined);
    await unlink(join(this.dir, "journal.lock")).catch(() => undefined);
  }

  /** Validates, deduplicates and persists one observation. Resolves only after the line is durable. */
  append(input: unknown): Promise<AppendResult> {
    const parsed = observationSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new ObservationValidationError(parsed.error.issues[0]?.message ?? "invalid"));
    const o = parsed.data;
    return this.enqueue(async () => {
      const id = observationId(o);
      const existing = this.state.byId.get(id);
      if (existing) return { status: "duplicate", seq: existing.seq, id };
      const slot = slotKey(o);
      if (this.state.bySlot.has(slot)) {
        // Same source evidence, different content: keep the first, refuse the second, and degrade.
        this.reasons.add("conflicting_source_evidence");
        throw new ObservationConflictError(slot);
      }
      const seq = await this.write("observation", o);
      return { status: "created", seq, id };
    });
  }

  /** Marks an observation as retracted (for example after a source reorganization). Idempotent. */
  retract(input: Retraction): Promise<{ status: "created" | "duplicate"; seq: number }> {
    const parsed = retractionSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new ObservationValidationError(parsed.error.issues[0]?.message ?? "invalid"));
    const r = parsed.data;
    return this.enqueue(async () => {
      const target = this.state.byId.get(r.observationId);
      if (!target || namespaceKey(target.observation.namespace) !== namespaceKey(r.namespace)) {
        throw new ObservationValidationError("retraction names an unknown observation");
      }
      const done = this.state.retracted.get(r.observationId);
      if (done) return { status: "duplicate", seq: done.seq };
      const seq = await this.write("retraction", r);
      return { status: "created", seq };
    });
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("observation journal is closed"));
    const run = this.writing.then(job, job);
    this.writing = run.then(() => undefined, () => undefined);
    return run;
  }

  private async write(kind: "observation" | "retraction", body: Observation | Retraction): Promise<number> {
    const seq = this.state.head.seq + 1;
    const hash = lineHash(this.state.head.headHash, seq, kind, body);
    const line: Line = { seq, kind, body, prev: this.state.head.headHash, hash };
    const text = `${JSON.stringify(line)}\n`;
    const size = Buffer.byteLength(text);
    if (size > MAX_LINE_BYTES) throw new ObservationValidationError("record exceeds the per-record size limit");
    if (seq > this.maxRecords) {
      this.reasons.add("capacity_records");
      throw new ObservationCapacityError("records");
    }
    if (this.bytes + size > this.maxBytes) {
      this.reasons.add("capacity_bytes");
      throw new ObservationCapacityError("bytes");
    }
    const handle = await open(join(this.dir, "journal.jsonl"), "a");
    try {
      await handle.write(text);
      await handle.datasync();
    } finally {
      await handle.close();
    }
    // Durable. Only now does the in-memory state (and so any reader or publisher) see the record.
    apply(this.state, line);
    this.bytes += size;
    try {
      await this.writeManifest();
      this.reasons.delete("manifest_write_failed");
    } catch {
      // The journal is the truth; a stale manifest is recoverable and visible.
      this.reasons.add("manifest_write_failed");
    }
    return seq;
  }

  private async writeManifest(): Promise<void> {
    const manifest: Manifest = { schema: JOURNAL_SCHEMA, count: this.state.head.seq, headHash: this.state.head.headHash, bytes: this.bytes };
    const path = join(this.dir, "manifest.json");
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(manifest), "utf8");
    await rename(tmp, path);
  }

  /** Size of the journal file on disk, for operators. */
  async sizeOnDisk(): Promise<number> {
    return (await stat(join(this.dir, "journal.jsonl")).catch(() => ({ size: 0 }))).size;
  }
}

export type { ObservationNamespace };
