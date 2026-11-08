import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditReport } from "./report.js";

/**
 * Durable, append-only archive of audit **report observations**. One observation is one
 * `AuditReport` (the allowlisted, user-facing projection built by `buildAuditReport`) plus the
 * trusted attribution the calling code supplies: which arena, battle and community it was produced
 * for, and whether the evidence is a fixture, a recorded sample or an established live source.
 *
 * Reports are historical observations, not current lock approval, proof of custody, transaction
 * execution, or certification that the mock token was audited. A reference-token report attests the
 * mainnet reference token on chain 4663, never the testnet mock on 46630; that distinction is kept
 * verbatim in every stored report and never flattened here.
 *
 * Identity model (read `decision.ts`): `evidenceHash` identifies the evidence (GoPlus + LP + asset
 * + policy) but does NOT commit to `result`/`reasons`. The same evidence re-evaluated later can
 * legitimately produce a different result (e.g. a pass that later goes stale), so an archive keyed
 * only by `evidenceHash` would lose history. We therefore key by a content-derived `observationId`
 * over the observation's DECISION content — provenance, domain, attribution and the report minus its
 * wall-clock `times` (`queriedAt`/`decidedAt`/`expiresAt`, which advance every scheduler pass for an
 * unchanged decision; the policy-derived `ttlSeconds` is kept). See {@link identityProjection}. So:
 *   - re-archiving the same decision is idempotent whatever the pass clock — a pending or rejected
 *     community re-evaluated every tick yields ONE observation, not one per tick (no unbounded growth),
 *   - a genuinely different evaluation (different result, reasons, evidence or policy) is preserved as
 *     a separate observation, keeping the first-seen timestamps,
 *   - a value claiming an existing `observationId` but with different decision content is rejected,
 *     never overwritten, so committed history is immutable.
 */

export const ARCHIVE_SCHEMA = "audit-report-archive-v1";
/** The report shape this archive version understands; bump with any breaking report change. */
export const REPORT_SCHEMA_VERSION = "audit-report-v1";

export type ArchiveProvenance = "fixture" | "recorded" | "live";
const PROVENANCES: readonly ArchiveProvenance[] = ["fixture", "recorded", "live"];

/** Trusted context the calling code attaches to a report; never derived from untrusted strings. */
export interface ReportAttribution {
  /** Arena contract/domain the lifecycle pass read from. Non-empty, bounded. */
  arena: string;
  battleId: number;
  community: number;
}

export interface ArchiveObservationInput {
  report: AuditReport;
  attribution: ReportAttribution;
  provenance: ArchiveProvenance;
}

/**
 * The observation core. Its decision projection ({@link identityProjection}) is hashed into
 * `observationId`; `seq`, `archivedAt` and the report's wall-clock `times` are metadata, never part
 * of the identity. `domain.custodyDomain` is the asset's custody domain (not a chain/network label).
 */
interface ObservationCore {
  reportSchemaVersion: string;
  provenance: ArchiveProvenance;
  domain: { arena: string; custodyDomain: string };
  attribution: { battleId: number; community: number };
  report: AuditReport;
}

export interface ArchivedObservation extends ObservationCore {
  observationId: string;
  /** Monotonic insertion order; the canonical stable sort key for pagination. */
  seq: number;
  /** First-write wall-clock time; idempotent retries keep the original. */
  archivedAt: string;
}

export interface PutResult {
  observation: ArchivedObservation;
  /** True when newly stored; false when an identical observation already existed (idempotent). */
  created: boolean;
}

export interface ReportArchive {
  put(input: ArchiveObservationInput): Promise<PutResult>;
  /** All observations in stable `seq` order. Throws on unsupported schema or corruption. */
  snapshot(): Promise<ArchivedObservation[]>;
}

/** Thrown when a conflicting value claims an existing observation id; history is preserved. */
export class ArchiveConflictError extends Error {
  constructor(public readonly observationId: string) {
    super("conflicting observation id: refusing to overwrite immutable history");
    this.name = "ArchiveConflictError";
  }
}

/** Thrown when stored state is unsupported or corrupt; never treated as empty history. */
export class ArchiveCorruptError extends Error {
  constructor(reason: string) {
    super(`audit report archive is unreadable: ${reason}`);
    this.name = "ArchiveCorruptError";
  }
}

/** Thrown when input fails validation; message is bounded and secret-free. */
export class ArchiveValidationError extends Error {
  constructor(reason: string) {
    super(`invalid audit report observation: ${reason}`);
    this.name = "ArchiveValidationError";
  }
}

/** Thrown when another writer holds the archive lock beyond the timeout. */
export class ArchiveLockedError extends Error {
  constructor() {
    super("audit report archive is locked by another writer");
    this.name = "ArchiveLockedError";
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const ARENA_MAX = 256;
/** Per-observation serialized size cap; overlong records are rejected, not truncated. */
export const MAX_OBSERVATION_BYTES = 64 * 1024;
/** Total observation cap. No auto-prune: an expired report is still historical evidence. */
export const MAX_OBSERVATIONS = 100_000;

/** Deterministic JSON with recursively sorted object keys, so fresh and reloaded cores hash alike. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const isIso = (s: string): boolean => s.length > 0 && !Number.isNaN(Date.parse(s));

/** Validates the report and attribution. Throws `ArchiveValidationError` with a bounded message. */
export function validateObservationInput(input: ArchiveObservationInput): void {
  const { report, attribution, provenance } = input;
  if (!PROVENANCES.includes(provenance)) throw new ArchiveValidationError("unknown provenance");
  if (typeof attribution.arena !== "string" || attribution.arena.length === 0 || attribution.arena.length > ARENA_MAX) {
    throw new ArchiveValidationError("arena must be a non-empty bounded string");
  }
  if (!Number.isInteger(attribution.battleId) || attribution.battleId < 0) {
    throw new ArchiveValidationError("battleId must be a non-negative integer");
  }
  if (!Number.isInteger(attribution.community) || attribution.community < 0) {
    throw new ArchiveValidationError("community must be a non-negative integer");
  }
  if (!report || typeof report !== "object") throw new ArchiveValidationError("report missing");
  if (typeof report.evidenceHash !== "string" || !HEX64.test(report.evidenceHash)) {
    throw new ArchiveValidationError("evidenceHash must be 32-byte lowercase hex");
  }
  if (typeof report.policy?.hash !== "string" || !HEX64.test(report.policy.hash)) {
    throw new ArchiveValidationError("policy hash must be 32-byte lowercase hex");
  }
  if (report.result !== "pass" && report.result !== "reject" && report.result !== "pending") {
    throw new ArchiveValidationError("result must be pass, reject or pending");
  }
  if (report.auditKind !== "direct" && report.auditKind !== "reference_token") {
    throw new ArchiveValidationError("auditKind must be direct or reference_token");
  }
  if (typeof report.times?.decidedAt !== "string" || !isIso(report.times.decidedAt)) {
    throw new ArchiveValidationError("decidedAt must be a valid timestamp");
  }
  if (report.times.expiresAt !== null && !isIso(String(report.times.expiresAt))) {
    throw new ArchiveValidationError("expiresAt must be null or a valid timestamp");
  }
  // queriedAt may legitimately be "" when no provider was queried; only reject a malformed non-empty value.
  if (typeof report.times.queriedAt !== "string" || (report.times.queriedAt !== "" && !isIso(report.times.queriedAt))) {
    throw new ArchiveValidationError("queriedAt must be empty or a valid timestamp");
  }
  if (report.result === "pass" && report.times.expiresAt === null) {
    throw new ArchiveValidationError("a pass must carry an expiry");
  }
  const size = Buffer.byteLength(canonicalJson(report), "utf8");
  if (size > MAX_OBSERVATION_BYTES) throw new ArchiveValidationError("report exceeds the size limit");
}

function coreOf(input: ArchiveObservationInput): ObservationCore {
  return {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    provenance: input.provenance,
    domain: { arena: input.attribution.arena, custodyDomain: input.report.asset.custodyDomain },
    attribution: { battleId: input.attribution.battleId, community: input.attribution.community },
    report: input.report,
  };
}

/**
 * The decision content an `observationId` commits to: everything in the core except the report's
 * wall-clock `times`. `queriedAt`/`decidedAt`/`expiresAt` advance on every scheduler pass for an
 * unchanged decision, so hashing them would make a pending or rejected community grow the archive by
 * one observation per tick. The policy-derived `ttlSeconds` is kept (it only moves with the policy,
 * which is already covered by `policy.hash`). Fields are listed explicitly so a stored observation's
 * envelope metadata (`observationId`/`seq`/`archivedAt`) can never leak into the identity.
 */
function identityProjection(core: ObservationCore): unknown {
  return {
    reportSchemaVersion: core.reportSchemaVersion,
    provenance: core.provenance,
    domain: core.domain,
    attribution: core.attribution,
    report: { ...core.report, times: { ttlSeconds: core.report.times.ttlSeconds } },
  };
}

/** Content-derived identity: hash of the decision projection, independent of the pass wall-clock. */
function observationIdOf(core: ObservationCore, hashFn: (text: string) => string): string {
  return hashFn(canonicalJson(identityProjection(core)));
}

/** True when two cores carry the same decision content (ignoring wall-clock); the collision guard. */
function sameDecision(a: ObservationCore, b: ObservationCore): boolean {
  return canonicalJson(identityProjection(a)) === canonicalJson(identityProjection(b));
}

const sha256Hex = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

/**
 * Whole-file structural integrity, checked on every load so a hand-edited archive cannot pass by
 * repairing only per-observation hashes. Requires unique observation ids, strictly increasing `seq`
 * (so duplicate, missing or reordered observations are caught), `nextSeq` past the largest `seq`, a
 * well-formed `archivedAt`, and a report that still passes {@link validateObservationInput} — the
 * shape is re-checked on read, not only its hash.
 */
function assertArchiveIntegrity(observations: ArchivedObservation[], nextSeq: number): void {
  const ids = new Set<string>();
  let prevSeq = 0;
  let maxSeq = 0;
  for (const o of observations) {
    if (ids.has(o.observationId)) throw new ArchiveCorruptError("duplicate observation id");
    ids.add(o.observationId);
    if (!Number.isInteger(o.seq) || o.seq < 1) throw new ArchiveCorruptError("seq must be a positive integer");
    if (o.seq <= prevSeq) throw new ArchiveCorruptError("seq is not strictly increasing");
    prevSeq = o.seq;
    if (o.seq > maxSeq) maxSeq = o.seq;
    if (typeof o.archivedAt !== "string" || !isIso(o.archivedAt)) {
      throw new ArchiveCorruptError("archivedAt is not a valid timestamp");
    }
    try {
      validateObservationInput({
        report: o.report,
        attribution: { arena: o.domain.arena, battleId: o.attribution.battleId, community: o.attribution.community },
        provenance: o.provenance,
      });
    } catch (err) {
      throw new ArchiveCorruptError(`stored report fails validation: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }
  if (!Number.isInteger(nextSeq) || nextSeq <= maxSeq) {
    throw new ArchiveCorruptError("nextSeq must be greater than the largest seq");
  }
}

function assertSupportedObservation(o: unknown, hashFn: (s: string) => string): ArchivedObservation {
  if (!o || typeof o !== "object") throw new ArchiveCorruptError("observation is not an object");
  const rec = o as Partial<ArchivedObservation>;
  if (rec.reportSchemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new ArchiveCorruptError(`unsupported report schema ${String(rec.reportSchemaVersion)}`);
  }
  if (typeof rec.observationId !== "string" || !Number.isInteger(rec.seq) || typeof rec.archivedAt !== "string") {
    throw new ArchiveCorruptError("observation envelope is malformed");
  }
  const core: ObservationCore = {
    reportSchemaVersion: rec.reportSchemaVersion,
    provenance: rec.provenance as ArchiveProvenance,
    domain: rec.domain as { arena: string; custodyDomain: string },
    attribution: rec.attribution as { battleId: number; community: number },
    report: rec.report as AuditReport,
  };
  // Re-derive the id so a hand-edited or corrupted body cannot masquerade as a valid observation.
  if (observationIdOf(core, hashFn) !== rec.observationId) {
    throw new ArchiveCorruptError("observation id does not match its contents");
  }
  return rec as ArchivedObservation;
}

interface ArchiveFile {
  schema: string;
  nextSeq: number;
  observations: ArchivedObservation[];
}

export interface JsonFileReportArchiveOptions {
  /** Injectable for tests (default sha256-hex); lets the conflict guard be exercised deterministically. */
  hashFn?: (text: string) => string;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  /** A lock older than this is treated as abandoned by a crashed writer and broken. */
  lockStaleMs?: number;
}

const DEFAULT_ARCHIVE_PATH = "./.agent-state/audit-reports/archive.json";

/**
 * Single-file JSON archive. Writes are serialized in-process and guarded across processes by a lock
 * file; each write re-reads committed state and appends (never rewrites existing observations), and
 * the file is replaced atomically (temp then rename). A missing file is an empty archive, but a
 * corrupt or unsupported file is an explicit error, never silently reset. Operating limits:
 * {@link MAX_OBSERVATION_BYTES} per report and {@link MAX_OBSERVATIONS} total; no retention/prune.
 */
export class JsonFileReportArchive implements ReportArchive {
  private writing: Promise<unknown> = Promise.resolve();
  private readonly hashFn: (text: string) => string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly lockStaleMs: number;

  constructor(
    private readonly path: string = DEFAULT_ARCHIVE_PATH,
    opts: JsonFileReportArchiveOptions = {},
  ) {
    this.hashFn = opts.hashFn ?? sha256Hex;
    this.lockPath = `${path}.lock`;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 5_000;
    this.lockRetryMs = opts.lockRetryMs ?? 25;
    this.lockStaleMs = opts.lockStaleMs ?? 30_000;
  }

  private async load(): Promise<ArchiveFile> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { schema: ARCHIVE_SCHEMA, nextSeq: 1, observations: [] };
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Unlike the baseline store, a corrupt archive is not lost state to reset: fail loudly.
      throw new ArchiveCorruptError("file is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ArchiveCorruptError("file is not an archive object");
    }
    const file = parsed as Partial<ArchiveFile>;
    if (file.schema !== ARCHIVE_SCHEMA) throw new ArchiveCorruptError(`unsupported schema ${String(file.schema)}`);
    if (!Array.isArray(file.observations) || !Number.isInteger(file.nextSeq)) {
      throw new ArchiveCorruptError("archive header is malformed");
    }
    const observations = file.observations.map((o) => assertSupportedObservation(o, this.hashFn));
    assertArchiveIntegrity(observations, file.nextSeq as number);
    return { schema: ARCHIVE_SCHEMA, nextSeq: file.nextSeq as number, observations };
  }

  async snapshot(): Promise<ArchivedObservation[]> {
    const file = await this.load();
    return [...file.observations].sort((a, b) => a.seq - b.seq);
  }

  put(input: ArchiveObservationInput): Promise<PutResult> {
    validateObservationInput(input);
    const core = coreOf(input);
    const observationId = observationIdOf(core, this.hashFn);
    const run = () =>
      this.withLock(async () => {
        const file = await this.load();
        const existing = file.observations.find((o) => o.observationId === observationId);
        if (existing) {
          // Same id and same decision content: idempotent (the first-written timestamps are kept). Same
          // id, different content: a hash collision or tampering — refuse rather than overwrite history.
          if (sameDecision(existing, core)) return { observation: existing, created: false };
          throw new ArchiveConflictError(observationId);
        }
        if (file.observations.length >= MAX_OBSERVATIONS) {
          throw new ArchiveValidationError("archive observation limit reached");
        }
        const observation: ArchivedObservation = {
          ...core,
          observationId,
          seq: file.nextSeq,
          archivedAt: new Date().toISOString(),
        };
        const next: ArchiveFile = {
          schema: ARCHIVE_SCHEMA,
          nextSeq: file.nextSeq + 1,
          observations: [...file.observations, observation],
        };
        await this.atomicWrite(next);
        return { observation, created: true };
      });
    // Serialize in-process writers so they do not spin on the lock; preserve each one's result/throw.
    const result = this.writing.then(run, run);
    this.writing = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async atomicWrite(file: ArchiveFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
    await rename(tmp, this.path);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.lockTimeoutMs;
    await mkdir(dirname(this.lockPath), { recursive: true });
    for (;;) {
      let acquired = false;
      try {
        const handle = await open(this.lockPath, "wx");
        await handle.close();
        acquired = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        await this.breakStaleLock();
        if (Date.now() > deadline) throw new ArchiveLockedError();
        await delay(this.lockRetryMs);
        continue;
      }
      if (acquired) {
        try {
          return await fn();
        } finally {
          await unlink(this.lockPath).catch(() => undefined);
        }
      }
    }
  }

  private async breakStaleLock(): Promise<void> {
    try {
      const st = await stat(this.lockPath);
      if (Date.now() - st.mtimeMs > this.lockStaleMs) await unlink(this.lockPath).catch(() => undefined);
    } catch {
      // lock vanished between the failed open and the stat: fine, the next attempt will acquire it.
    }
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Process-local archive for tests and read-only query assembly. Enforces the same identity rules. */
export class InMemoryReportArchive implements ReportArchive {
  private readonly byId = new Map<string, ArchivedObservation>();
  private seq = 1;
  private readonly hashFn: (text: string) => string;

  constructor(opts: { hashFn?: (text: string) => string } = {}) {
    this.hashFn = opts.hashFn ?? sha256Hex;
  }

  async put(input: ArchiveObservationInput): Promise<PutResult> {
    validateObservationInput(input);
    const core = coreOf(input);
    const observationId = observationIdOf(core, this.hashFn);
    const existing = this.byId.get(observationId);
    if (existing) {
      if (sameDecision(existing, core)) return { observation: existing, created: false };
      throw new ArchiveConflictError(observationId);
    }
    if (this.byId.size >= MAX_OBSERVATIONS) throw new ArchiveValidationError("archive observation limit reached");
    const observation: ArchivedObservation = { ...core, observationId, seq: this.seq++, archivedAt: new Date().toISOString() };
    this.byId.set(observationId, observation);
    return { observation, created: true };
  }

  async snapshot(): Promise<ArchivedObservation[]> {
    return [...this.byId.values()].sort((a, b) => a.seq - b.seq);
  }
}
