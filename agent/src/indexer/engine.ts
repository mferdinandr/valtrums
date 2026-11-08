import { silentLogger, type Logger } from "../logger.js";
import { parseBlock } from "./parser.js";
import { buildProjection, type Projection } from "./projection.js";
import { JsonFileIndexerStore, MAX_DIAGNOSTICS, type StoreState } from "./store.js";
import type {
  BlockRef,
  BlockSource,
  DiagnosticReason,
  IndexerConfig,
  IndexerHealth,
  IndexerHealthStatus,
  RecordedBlock,
} from "./types.js";

/**
 * Quarantine reasons that mean the indexer may be missing or mis-reading state an allowlisted emitter
 * produced (a coverage/integrity gap), so the projection is no longer trustworthy as current truth.
 * Foreign-emitter and failed-outcome logs are not our state and never degrade. After parsing checks
 * the emitter allowlist first, these only arise from allowlisted contracts.
 */
const DEGRADING_REASONS: ReadonlySet<DiagnosticReason> = new Set<DiagnosticReason>([
  "malformed_payload",
  "unsafe_numeric",
  "malformed_envelope",
  "unsupported_version",
  "unknown_event",
]);

/**
 * Reasons worth persisting and acting on: conflicts plus allowlisted-emitter integrity/coverage gaps.
 * Everything else (`wrong_emitter`, `failed_outcome` — logs an untrusted account can spam at will) is
 * merely counted, never stored, so it can neither evict a conflict record nor poison health.
 */
function isAttentionReason(reason: DiagnosticReason): boolean {
  return reason === "conflict_payload" || DEGRADING_REASONS.has(reason);
}

const REASON_BY_STATUS: Record<IndexerHealthStatus, string> = {
  healthy: "caught up to the source head with consistent finality",
  pending: "awaiting finality or further source coverage",
  degraded: "integrity/coverage quarantine or finality regression requires attention",
  reconciliation_required: "fork or conflict beyond safe automatic recovery; manual reconciliation required",
};

/**
 * Read-only indexing engine: ingest canonical blocks from an injected source, deduplicate and
 * accept events, reconcile provisional forks against the source, promote finality only along the
 * source-declared finalized ancestor chain, and persist a replayable journal. It has no write
 * authority: the source and store are read/local-only, and a retraction is a read-model operation
 * that never refunds, restores backing, or sends a payout. Finality and provisional status are kept
 * distinct; a source label is a declared assertion, never verified finality.
 */

export interface EngineOptions {
  now?: () => number;
  /** Max blocks ingested per sync call, bounding work per pass. */
  maxBlocksPerSync?: number;
  /** Max quarantine records retained; older ones are dropped and counted. Defaults to the store cap. */
  maxDiagnostics?: number;
  log?: Logger;
}

export class IndexerEngine {
  private state!: StoreState;
  private dedup = new Map<string, string>();
  private readonly now: () => number;
  private readonly maxPerSync: number;
  private readonly maxDiag: number;
  private readonly log: Logger;
  private lastSyncMs: number | null = null;

  constructor(
    private readonly source: BlockSource,
    private readonly store: JsonFileIndexerStore,
    private readonly config: IndexerConfig,
    opts: EngineOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.maxPerSync = opts.maxBlocksPerSync ?? 10_000;
    this.maxDiag = opts.maxDiagnostics ?? MAX_DIAGNOSTICS;
    this.log = opts.log ?? silentLogger;
  }

  async open(): Promise<void> {
    const id = this.source.identity();
    if (id.network !== this.config.network) {
      throw new Error("source network does not match the configured network");
    }
    this.state = await this.store.open(this.config);
    this.rebuildDedup();
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private rebuildDedup(): void {
    this.dedup.clear();
    for (const e of this.state.journal) this.dedup.set(e.dedupKey, e.payloadDigest);
  }

  private committedFinalizedHeight(): bigint {
    const f = this.state.cursors.finalizedHead;
    return f ? BigInt(f.height) : -1n;
  }

  /** The deterministic projection over the committed journal at the committed finalized height. */
  projection(): Projection {
    return buildProjection(this.state.journal, {
      finalizedHeight: this.committedFinalizedHeight(),
      reducerVersion: this.config.reducerVersion,
    });
  }

  /**
   * The last persisted health. It is read from committed state, so a restart reports the real last
   * status (pending/degraded/reconciliation_required) instead of defaulting to healthy; the next
   * {@link sync} recomputes it.
   */
  health(): IndexerHealth {
    const h = this.state?.health ?? { status: "pending" as IndexerHealthStatus, reason: "no sync has run yet" };
    return this.buildHealth(h.status, h.reason);
  }

  /** One ingest + reconcile pass. Commits the resulting state. Returns the new health. */
  async sync(): Promise<IndexerHealth> {
    const flags: SyncFlags = { reconciliation: false, degraded: false, pending: false, reason: "" };
    const committedFinalBefore = this.committedFinalizedHeight();

    const { latest, finalized } = await this.source.head();

    await this.reconcileProvisional(flags);
    if (!flags.reconciliation) await this.extend(flags);
    if (!flags.reconciliation) this.promoteFinality(finalized, committedFinalBefore, flags);

    // Caught up only when the processed head equals the source latest head by hash.
    const head = this.state.cursors.processedHead;
    const caughtUp = latest !== null && head !== null && head.height === latest.height && head.hash === latest.hash;
    if (!flags.reconciliation && (!caughtUp || finalized === null)) {
      flags.pending = true;
      if (!flags.reason) flags.reason = finalized === null ? "source declares no finalized head" : "not yet caught up to the source head";
    }

    this.capDiagnostics();
    const status = this.deriveStatus(flags);
    const reason = flags.reason || REASON_BY_STATUS[status];
    this.state.health = { status, reason };
    this.lastSyncMs = this.now();
    await this.store.commit(this.state);

    const health = this.buildHealth(status, reason);
    this.log.info("indexer sync", {
      status,
      reason,
      processedHead: head?.height ?? null,
      finalizedHead: this.state.cursors.finalizedHead?.height ?? null,
      quarantined: this.state.diagnostics.length,
      diagnosticsDropped: this.state.diagnosticsDropped,
      ignoredLogs: this.state.ignoredLogs,
    });
    return health;
  }

  private async reconcileProvisional(flags: SyncFlags): Promise<void> {
    const provisional = this.state.blocks.filter((b) => !b.finalized).sort((a, b) => cmpHeight(a.height, b.height));
    for (const sb of provisional) {
      const at = await this.source.blockAt(sb.height);
      if (at.kind === "block") {
        if (at.block.header.hash === sb.hash) continue; // still canonical
        return this.rollbackFrom(BigInt(sb.height), flags); // replaced provisional history
      }
      if (at.kind === "incomplete") {
        // Cannot verify this height right now; stop here and report pending rather than guess.
        flags.pending = true;
        flags.reason = `source coverage incomplete at height ${sb.height}`;
        return;
      }
      // skipped or beyond_head: our block no longer exists on the source -> orphaned.
      return this.rollbackFrom(BigInt(sb.height), flags);
    }
  }

  private rollbackFrom(height: bigint, flags: SyncFlags): void {
    const orphan = new Set(this.state.blocks.filter((b) => cmpHeight(b.height, height.toString()) >= 0).map((b) => b.hash));
    // A conflict at or below the finalized boundary must not rewrite finalized state.
    if (this.state.blocks.some((b) => orphan.has(b.hash) && b.finalized)) {
      flags.reconciliation = true;
      flags.reason = `fork conflicts with finalized state at or below height ${height.toString()}; preserving evidence`;
      return;
    }
    this.state.blocks = this.state.blocks.filter((b) => !orphan.has(b.hash));
    this.state.journal = this.state.journal.filter((e) => !orphan.has(e.provenance.blockHash));
    this.state.diagnostics = this.state.diagnostics.filter((d) => !orphan.has(d.provenance.blockHash));
    this.rebuildDedup();
    const tip = [...this.state.blocks].sort((a, b) => cmpHeight(a.height, b.height)).at(-1) ?? null;
    this.state.cursors.processedHead = tip ? { height: tip.height, hash: tip.hash } : null;
  }

  private async extend(flags: SyncFlags): Promise<void> {
    let headHash = this.state.cursors.processedHead?.hash ?? this.config.anchorHash;
    let height = this.state.cursors.processedHead
      ? BigInt(this.state.cursors.processedHead.height) + 1n
      : BigInt(this.config.anchorHeight);
    for (let count = 0; count < this.maxPerSync; count++) {
      const at = await this.source.blockAt(height.toString());
      if (at.kind === "beyond_head") return;
      if (at.kind === "skipped") {
        height += 1n;
        continue;
      }
      if (at.kind === "incomplete") {
        flags.pending = true;
        flags.reason = `source coverage incomplete at height ${height.toString()}`;
        return;
      }
      const blk = at.block;
      if (!blk.complete) {
        // The block exists but the source declares its receipts/logs are not fully available. Treat it
        // exactly like an `incomplete` coverage gap: stop here, report pending, never advance over it.
        flags.pending = true;
        flags.reason = `source block at height ${height.toString()} is incomplete`;
        return;
      }
      if (blk.network !== this.config.network) {
        flags.reconciliation = true;
        flags.reason = `block at height ${height.toString()} belongs to another network`;
        return;
      }
      if (blk.header.parentHash !== headHash) {
        // Reconcile already rolled back a divergent tip, so a parent mismatch here is a source
        // inconsistency: stop and require reconciliation rather than linking a broken chain.
        flags.reconciliation = true;
        flags.reason = `parent linkage broken at height ${height.toString()}`;
        return;
      }
      this.applyBlock(blk, flags);
      headHash = blk.header.hash;
      this.state.cursors.processedHead = { height: blk.header.height, hash: blk.header.hash };
      height = BigInt(blk.header.height) + 1n;
    }
  }

  private applyBlock(blk: RecordedBlock, flags: SyncFlags): void {
    const { accepted, diagnostics } = parseBlock(blk, this.config);
    for (const e of accepted) {
      const prev = this.dedup.get(e.dedupKey);
      if (prev === undefined) {
        this.state.journal.push(e);
        this.dedup.set(e.dedupKey, e.payloadDigest);
      } else if (prev !== e.payloadDigest) {
        // Same identity, different payload: a conflict requiring reconciliation, never last-write-wins.
        this.state.diagnostics.push({
          dedupKey: e.dedupKey,
          reason: "conflict_payload",
          provenance: e.provenance,
          rawLog: "",
          standard: this.config.standard,
        });
        flags.reconciliation = true;
        flags.reason = `event ${e.dedupKey} reappeared with a different payload`;
      }
    }
    for (const d of diagnostics) {
      // Only attention-worthy quarantine (a conflict, or an integrity/coverage gap from an allowlisted
      // emitter) is persisted and can affect health. Benign records a foreign account can spam are
      // counted only, so an untrusted flood can neither evict these records nor degrade health.
      if (isAttentionReason(d.reason)) this.state.diagnostics.push(d);
      else this.state.ignoredLogs += 1;
    }
    this.state.blocks.push({
      height: blk.header.height,
      hash: blk.header.hash,
      parentHash: blk.header.parentHash,
      timestampMs: blk.header.timestampMs,
      finalized: false,
    });
  }

  private promoteFinality(finalized: BlockRef | null, committedBefore: bigint, flags: SyncFlags): void {
    if (finalized === null) return;
    const fh = BigInt(finalized.height);
    if (fh < committedBefore) {
      flags.degraded = true;
      flags.reason = "source finalized head regressed below the committed finalized height";
      return; // keep the committed finalized state; never un-finalize
    }
    const fb = this.state.blocks.find((b) => b.height === finalized.height);
    if (!fb) {
      flags.pending = true;
      if (!flags.reason) flags.reason = `source finalized head ${finalized.height} not yet processed`;
      return;
    }
    if (fb.hash !== finalized.hash) {
      flags.reconciliation = true;
      flags.reason = `source finalizes a different block at height ${finalized.height} than the processed chain`;
      return;
    }
    for (const b of this.state.blocks) if (cmpHeight(b.height, finalized.height) <= 0) b.finalized = true;
    this.state.cursors.finalizedHead = { height: finalized.height, hash: finalized.hash };
  }

  private deriveStatus(flags?: SyncFlags): IndexerHealthStatus {
    const diag = this.state?.diagnostics ?? [];
    const hasConflict = diag.some((d) => d.reason === "conflict_payload");
    const hasDegrading = diag.some((d) => DEGRADING_REASONS.has(d.reason)) || (this.state?.diagnosticsDropped ?? 0) > 0;
    if (flags?.reconciliation || hasConflict) return "reconciliation_required";
    if (flags?.degraded || hasDegrading) return "degraded";
    if (flags?.pending) return "pending";
    return "healthy";
  }

  private buildHealth(status: IndexerHealthStatus, reason: string): IndexerHealth {
    return {
      status,
      reason,
      source: this.source.identity(),
      processedHead: this.state?.cursors.processedHead ?? null,
      finalizedHead: this.state?.cursors.finalizedHead ?? null,
      quarantined: this.state?.diagnostics.length ?? 0,
      lastSyncMs: this.lastSyncMs,
    };
  }

  /**
   * Bound the attention-quarantine list: keep the most recent records and count the rest. Only
   * conflict/degrading records (from allowlisted emitters) ever reach this list, so an overflow here
   * is a real trusted-side signal that legitimately degrades health; a foreign flood never gets here.
   */
  private capDiagnostics(): void {
    const over = this.state.diagnostics.length - this.maxDiag;
    if (over > 0) {
      this.state.diagnostics = this.state.diagnostics.slice(over);
      this.state.diagnosticsDropped += over;
    }
  }
}

interface SyncFlags {
  reconciliation: boolean;
  degraded: boolean;
  pending: boolean;
  reason: string;
}

/** Compare decimal height strings without precision loss. */
function cmpHeight(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
