import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eventPayloadDigest } from "./parser.js";
import type { AcceptedEvent, BlockRef, DiagnosticRecord, IndexerConfig, IndexerHealthStatus } from "./types.js";

/**
 * Durable indexer state as one versioned atomic snapshot, with stronger recovery guarantees than
 * the legacy baseline store: corrupt or unsupported state is preserved and fails closed with a
 * recovery message, never silently reset to an empty cursor. A single-writer lock prevents two runs
 * from overwriting the same state directory. Operating limits are bounded and documented; there is
 * no retention/prune, so the snapshot grows with processed blocks and accepted events.
 */

export const STORE_SCHEMA = "arena-indexer-store-v1";
export const MAX_BLOCKS = 500_000;
export const MAX_JOURNAL = 1_000_000;
export const MAX_DIAGNOSTICS = 100_000;

export interface StoredBlock {
  height: string;
  hash: string;
  parentHash: string | null;
  timestampMs: string;
  finalized: boolean;
}

/**
 * Set when a provisional fork was retracted: confirmations that depend on the replaced range stay
 * suspended until the source finalizes a block at or above `untilFinalizedHeight` on the canonical chain.
 */
export interface ReorgSuspension {
  /** Lowest height whose provisional blocks were retracted (decimal string). */
  sinceHeight: string;
  /** Highest retracted height; finality must reach it on the canonical chain to lift the suspension. */
  untilFinalizedHeight: string;
  retractedBlocks: number;
  retractedEvents: number;
  reason: string;
}

export interface StoreState {
  schema: string;
  config: IndexerConfig;
  /** Processed chain in ascending height order (finalized prefix then provisional tail). */
  blocks: StoredBlock[];
  /** Accepted events; order is not relied upon (the reducer sorts canonically). */
  journal: AcceptedEvent[];
  /**
   * Attention-worthy quarantine only: conflicts and integrity/coverage gaps from an allowlisted
   * emitter. Benign records an untrusted account can spam (`wrong_emitter`, `failed_outcome`) are
   * never stored here, so they cannot evict these records or poison health.
   */
  diagnostics: DiagnosticRecord[];
  /** Historical count of dropped details; diagnosticOverflowBlocks retains their active severity. */
  diagnosticsDropped: number;
  /** Count of benign/ignored logs (foreign emitter, failed outcome); never affects health. */
  ignoredLogs: number;
  /** Conflicting source blocks retained independently of the disposable diagnostic cap. */
  conflictBlocks: string[];
  /** Source blocks whose retained diagnostic details overflowed the cap; cleared by orphan rollback. */
  diagnosticOverflowBlocks: string[];
  cursors: { processedHead: BlockRef | null; finalizedHead: BlockRef | null };
  /** Last computed health, persisted so a restart never silently reports healthy. */
  health: { status: IndexerHealthStatus; reason: string };
  /** Active reorg suspension of dependent confirmations; null when none. Persisted across restarts. */
  reorgSuspension: ReorgSuspension | null;
}

/** Health persisted into a freshly created store before any sync has run. */
const INITIAL_HEALTH = { status: "pending" as IndexerHealthStatus, reason: "no sync has run yet" };

export class StoreCorruptError extends Error {
  constructor(reason: string, public readonly path: string) {
    super(
      `indexer state at ${path} is ${reason}. It is preserved for diagnosis and NOT reset. ` +
        `Inspect or move it aside; do not delete it blindly, as the finalized cursor cannot be rebuilt from an empty store.`,
    );
    this.name = "StoreCorruptError";
  }
}

export class StoreConfigConflictError extends Error {
  constructor(field: string) {
    super(`indexer state was created under a different ${field}; refusing to reopen under a conflicting configuration`);
    this.name = "StoreConfigConflictError";
  }
}

export class StoreLockedError extends Error {
  constructor(dir: string) {
    super(`indexer state directory ${dir} is locked by another writer`);
    this.name = "StoreLockedError";
  }
}

export class StoreLimitError extends Error {
  constructor(what: string) {
    super(`indexer state ${what} limit reached; stopping rather than dropping committed history`);
    this.name = "StoreLimitError";
  }
}

export interface IndexerStoreOptions {
  /** @deprecated Locks never expire by age; retained for caller compatibility only. */
  lockStaleMs?: number;
}

export class JsonFileIndexerStore {
  private readonly statePath: string;
  private readonly lockPath: string;
  private locked = false;

  constructor(private readonly dir: string, _opts: IndexerStoreOptions = {}) {
    this.statePath = join(dir, "state.json");
    this.lockPath = join(dir, "state.lock");
  }

  /** Load state without taking the writer lock (for read-only status/replay). Throws on corruption. */
  async read(): Promise<StoreState | null> {
    let text: string;
    try {
      text = await readFile(this.statePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; // missing initial state
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StoreCorruptError("not valid JSON", this.statePath);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new StoreCorruptError("not a state object", this.statePath);
    const s = parsed as Partial<StoreState>;
    if (s.schema !== STORE_SCHEMA) throw new StoreCorruptError(`an unsupported schema (${String(s.schema)})`, this.statePath);
    if (!s.config || !Array.isArray(s.blocks) || !Array.isArray(s.journal) || !Array.isArray(s.diagnostics) || !s.cursors) {
      throw new StoreCorruptError("structurally malformed", this.statePath);
    }
    // Default fields added after the first schema cut, so a snapshot that predates them loads with a
    // safe (non-healthy) health rather than being treated as corrupt.
    if (s.diagnosticsDropped === undefined) s.diagnosticsDropped = 0;
    if (s.ignoredLogs === undefined) s.ignoredLogs = 0;
    const legacyHealth = s.health === undefined;
    if (legacyHealth) {
      s.health = { status: "pending", reason: "restored state predates health persistence" };
    }
    if (s.conflictBlocks === undefined) {
      // Earlier snapshots kept conflicts only in capped diagnostics. If that evidence was dropped,
      // keep reconciliation sticky rather than silently guessing that an old conflict was resolved.
      s.conflictBlocks = s.diagnostics.filter((d) => d?.reason === "conflict_payload").map((d) => d.provenance?.blockHash);
      if (s.health?.status === "reconciliation_required" && s.diagnosticsDropped > 0 && s.conflictBlocks.length === 0) {
        s.conflictBlocks = s.blocks.map((b) => b?.hash);
      }
      s.conflictBlocks = [...new Set(s.conflictBlocks)];
      if (legacyHealth && s.conflictBlocks.length > 0) {
        s.health = { status: "reconciliation_required", reason: "restored unresolved event conflicts from legacy diagnostics" };
      }
    }
    if (s.reorgSuspension === undefined) s.reorgSuspension = null;
    if (s.diagnosticOverflowBlocks === undefined) {
      s.diagnosticOverflowBlocks = s.diagnosticsDropped > 0 ? s.blocks.map((b) => b?.hash) : [];
    }
    try {
      validateState(s as StoreState);
    } catch (err) {
      throw new StoreCorruptError(err instanceof Error ? err.message : "invalid state invariants", this.statePath);
    }
    return s as StoreState;
  }

  /** Acquire the single-writer lock, then load or establish state. Validates config compatibility. */
  async open(config: IndexerConfig): Promise<StoreState> {
    await this.acquire();
    try {
      const existing = await this.read();
      if (!existing) {
        return {
          schema: STORE_SCHEMA,
          config,
          blocks: [],
          journal: [],
          diagnostics: [],
          diagnosticsDropped: 0,
          ignoredLogs: 0,
          conflictBlocks: [],
          diagnosticOverflowBlocks: [],
          cursors: { processedHead: null, finalizedHead: null },
          health: { ...INITIAL_HEALTH },
          reorgSuspension: null,
        };
      }
      assertCompatibleConfig(existing.config, config);
      return existing;
    } catch (err) {
      await this.release();
      throw err;
    }
  }

  /** Atomically persist state. The lock must be held. */
  async commit(state: StoreState): Promise<void> {
    if (!this.locked) throw new Error("indexer store commit without the writer lock");
    if (state.blocks.length > MAX_BLOCKS) throw new StoreLimitError("block");
    if (state.journal.length > MAX_JOURNAL) throw new StoreLimitError("journal");
    // Diagnostics are disposable quarantine records, not committed history: clamp rather than throw,
    // so an unbounded quarantine (e.g. a flood of foreign-emitter logs) can never wedge commit.
    if (state.diagnostics.length > MAX_DIAGNOSTICS) {
      const dropped = state.diagnostics.length - MAX_DIAGNOSTICS;
      for (const d of state.diagnostics.slice(0, dropped)) {
        if (!state.diagnosticOverflowBlocks.includes(d.provenance.blockHash)) state.diagnosticOverflowBlocks.push(d.provenance.blockHash);
      }
      state.diagnostics = state.diagnostics.slice(dropped);
      state.diagnosticsDropped += dropped;
    }
    validateState(state);
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...state, schema: STORE_SCHEMA }, null, 2), "utf8");
    await rename(tmp, this.statePath); // atomic replace; a crash before this keeps the last state
  }

  async close(): Promise<void> {
    await this.release();
  }

  private async acquire(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      const h = await open(this.lockPath, "wx");
      await h.close();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // A long-running or paused writer is not a crashed writer. Never steal by file age.
      // Recovery requires an operator to establish that all writers stopped before removing it.
      throw new StoreLockedError(this.dir);
    }
    this.locked = true;
  }

  private async release(): Promise<void> {
    if (!this.locked) return;
    this.locked = false;
    await unlink(this.lockPath).catch(() => undefined);
  }
}

function assertCompatibleConfig(stored: IndexerConfig, incoming: IndexerConfig): void {
  const scalar: (keyof IndexerConfig)[] = ["network", "standard", "schemaVersion", "reducerVersion", "anchorHash", "anchorHeight"];
  for (const k of scalar) {
    if (stored[k] !== incoming[k]) throw new StoreConfigConflictError(k);
  }
  const setEq = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
  if (!setEq(stored.contracts, incoming.contracts)) throw new StoreConfigConflictError("contracts");
  if (!setEq(stored.supportedVersions, incoming.supportedVersions)) throw new StoreConfigConflictError("supportedVersions");
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEALTH = new Set(["healthy", "pending", "degraded", "reconciliation_required"]);
const REASONS = new Set([
  "unrelated_log", "other_standard", "malformed_envelope", "unsupported_version", "unknown_event",
  "wrong_emitter", "failed_outcome", "unsafe_numeric", "malformed_payload", "conflict_payload",
]);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && value.length <= 16_384 && DECIMAL.test(value);
}

function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Shape, commitment and cross-record validation; these checks detect corruption, not a hostile
 * operator rewriting both data and checksums. The source remains a declared trust boundary. */
function validateState(state: StoreState): void {
  const cfg = record(state.config, "config");
  for (const key of ["network", "standard", "schemaVersion", "reducerVersion"]) check(text(cfg[key]), `invalid config ${key}`);
  check(decimal(cfg.anchorHeight) && (cfg.anchorHash === null || text(cfg.anchorHash)), "invalid start anchor");
  check(counter(cfg.retainedDepth), "invalid retained depth");
  for (const key of ["contracts", "supportedVersions"]) {
    const values = cfg[key];
    check(Array.isArray(values) && values.length > 0 && values.every(text) && new Set(values).size === values.length, `invalid config ${key}`);
  }
  check(Array.isArray(state.blocks) && state.blocks.length <= MAX_BLOCKS, "invalid block list");
  check(Array.isArray(state.journal) && state.journal.length <= MAX_JOURNAL, "invalid journal list");
  check(Array.isArray(state.diagnostics) && state.diagnostics.length <= MAX_DIAGNOSTICS, "invalid diagnostic list");
  check(counter(state.diagnosticsDropped) && counter(state.ignoredLogs), "invalid diagnostic counters");
  const health = record(state.health, "health");
  check(typeof health.status === "string" && HEALTH.has(health.status) && typeof health.reason === "string", "invalid health status");
  const suspension = state.reorgSuspension;
  if (suspension !== null) {
    const r = record(suspension, "reorg suspension");
    check(decimal(r.sinceHeight) && decimal(r.untilFinalizedHeight) && BigInt(r.sinceHeight) <= BigInt(r.untilFinalizedHeight), "invalid reorg suspension heights");
    check(counter(r.retractedBlocks) && counter(r.retractedEvents) && typeof r.reason === "string" && r.reason.length <= 512, "invalid reorg suspension counters");
    check(state.health.status !== "healthy", "healthy status hides an active reorg suspension");
  }
  const blocks = new Map<string, StoredBlock>();
  let previous: StoredBlock | undefined;
  let finalized: StoredBlock | undefined;
  let provisionalSeen = false;
  for (const raw of state.blocks) {
    const b = record(raw, "block");
    check(decimal(b.height) && decimal(b.timestampMs) && text(b.hash), "invalid block identity/time");
    check(b.parentHash === null || text(b.parentHash), "invalid block parent");
    check(typeof b.finalized === "boolean", "invalid block finality");
    check(!blocks.has(b.hash), "duplicate block hash");
    check(previous ? BigInt(b.height) > BigInt(previous.height) && b.parentHash === previous.hash
      : BigInt(b.height) >= BigInt(state.config.anchorHeight) && b.parentHash === state.config.anchorHash, "broken block ordering or parent linkage");
    if (b.finalized) {
      check(!provisionalSeen, "finalized blocks must be a prefix");
      finalized = raw;
    } else provisionalSeen = true;
    blocks.set(b.hash, raw);
    previous = raw;
  }
  const cursors = record(state.cursors, "cursors");
  const matches = (value: unknown, block: StoredBlock | undefined): boolean => {
    if (!block) return value === null;
    const ref = record(value, "cursor");
    return ref.height === block.height && ref.hash === block.hash;
  };
  check(matches(cursors.processedHead, previous), "processed cursor differs from the block tip");
  check(matches(cursors.finalizedHead, finalized), "finalized cursor differs from the finalized prefix");

  const provenance = (value: unknown) => {
    const p = record(value, "event provenance");
    const block = typeof p.blockHash === "string" ? blocks.get(p.blockHash) : undefined;
    check(block && p.blockHeight === block.height && p.blockTimestampMs === block.timestampMs, "event references an absent or inconsistent block");
    check(p.network === state.config.network && typeof p.contract === "string" && state.config.contracts.includes(p.contract), "event source differs from the configured domain");
    check(text(p.receiptId) && counter(p.outcomeIndex) && counter(p.logIndex) && counter(p.itemIndex), "invalid event identity/index");
    check(p.outcomeSuccess === true, "accepted/quarantined event must have a successful outcome");
    return `${p.network}|${p.contract}|${p.receiptId}|${p.logIndex}|${p.itemIndex}`;
  };
  const eventKeys = new Set<string>();
  for (const raw of state.journal) {
    const e = record(raw, "journal event");
    const key = provenance(e.provenance);
    check(e.dedupKey === key && !eventKeys.has(key), "duplicate or inconsistent event key");
    eventKeys.add(key);
    const name = String(e.name);
    const acct = (v: unknown): boolean => text(v) && (v as string).length <= 64;
    const optAcct = (v: unknown): boolean => v === null || acct(v);
    const optDec = (v: unknown): boolean => v === null || decimal(v);
    const hex64 = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
    if (name === "lifecycle_battle_created") check(decimal(e.battleId) && acct(e.creator), "invalid creator");
    else if (name === "lifecycle_deposit") check(decimal(e.battleId) && decimal(e.community) && acct(e.accountId) && decimal(e.amount), "invalid deposit");
    else if (name === "audit_updated") check(decimal(e.battleId) && decimal(e.community) && ["pass", "reject", "pending"].includes(String(e.result)) && text(e.evidenceHash) && optDec(e.expiresAtMs), "invalid audit");
    else if (name === "backing_updated") check(decimal(e.battleId) && decimal(e.community) && typeof e.approved === "boolean" && (e.evidenceHash === null || text(e.evidenceHash)) && optDec(e.expiresAtMs), "invalid backing update");
    else if (name === "lifecycle_representation_trust_changed") check(acct(e.representation) && typeof e.trusted === "boolean", "invalid trust change");
    else if (name === "late_deposit_recorded") check(decimal(e.battleId) && acct(e.beneficiary) && text(e.refundAddress) && decimal(e.units), "invalid late deposit");
    else if (name === "asset_suspended") check(text(e.reason), "invalid suspension");
    else if (name === "asset_resumed") check(acct(e.by) && typeof e.reorg === "boolean" && typeof e.deficit === "boolean" && typeof e.stillSuspended === "boolean", "invalid resume");
    else if (name === "custody_attested") check(decimal(e.sequence) && decimal(e.sourceBlockNumber) && decimal(e.balance) && optDec(e.required) && typeof e.covered === "boolean", "invalid attestation");
    else if (name === "reconciliation_unresolved") check(acct(e.holder) && hex64(e.requestId), "invalid unresolved reconciliation");
    else if (name === "operator_changed") check(optAcct(e.previous) && optAcct(e.next) && acct(e.by), "invalid operator change");
    else if (name === "resume_policy_changed") check(text(e.previous) && text(e.next) && acct(e.by), "invalid resume policy change");
    else if (name === "payout_signature_requested") check(acct(e.backing) && acct(e.holder) && hex64(e.requestId) && hex64(e.payloadHash) && decimal(e.maxFeePerGas) && decimal(e.nonce), "invalid payout signature request");
    else if (name === "payout_signature_received") check(acct(e.backing) && acct(e.holder) && hex64(e.requestId) && hex64(e.txHash) && decimal(e.maxFeePerGas), "invalid payout signature");
    else if (name === "payout_signature_failed") check(acct(e.backing) && acct(e.holder) && hex64(e.requestId) && decimal(e.maxFeePerGas), "invalid payout signature failure");
    else if (name === "payout_state_changed") check(acct(e.backing) && acct(e.holder) && hex64(e.requestId) && (e.from === null || text(e.from)) && text(e.to) && (e.reason === null || text(e.reason)), "invalid payout state");
    else check(false, "unsupported journal event");
    check(typeof e.payloadDigest === "string" && /^[0-9a-f]{64}$/.test(e.payloadDigest) && eventPayloadDigest(raw) === e.payloadDigest, "journal payload digest mismatch");
  }
  for (const raw of state.diagnostics) {
    const d = record(raw, "diagnostic");
    const key = provenance(d.provenance);
    check(d.dedupKey === key && typeof d.reason === "string" && REASONS.has(d.reason), "invalid diagnostic identity/reason");
    check(typeof d.rawLog === "string" && d.rawLog.length <= 16_384, "invalid diagnostic body");
    for (const key of ["standard", "version", "event"]) check(d[key] === undefined || typeof d[key] === "string", "invalid diagnostic envelope");
  }
  check(Array.isArray(state.conflictBlocks) && new Set(state.conflictBlocks).size === state.conflictBlocks.length && state.conflictBlocks.every((hash) => typeof hash === "string" && blocks.has(hash)), "invalid unresolved conflict blocks");
  check(Array.isArray(state.diagnosticOverflowBlocks) && new Set(state.diagnosticOverflowBlocks).size === state.diagnosticOverflowBlocks.length && state.diagnosticOverflowBlocks.every((hash) => typeof hash === "string" && blocks.has(hash)), "invalid diagnostic overflow blocks");
  check(state.diagnostics.every((d) => d.reason !== "conflict_payload" || state.conflictBlocks.includes(d.provenance.blockHash)), "conflict diagnostic has no durable marker");
  check(state.conflictBlocks.length === 0 || state.health.status === "reconciliation_required", "unresolved conflict must require reconciliation");
  check(state.health.status !== "healthy" || (state.diagnostics.length === 0 && state.diagnosticOverflowBlocks.length === 0), "healthy status hides retained integrity diagnostics");
}
