import type { BlockAt, BlockRef, BlockSource, RecordedBlock, ReceiptOutcome, SourceIdentity } from "./types.js";

/**
 * A recorded/replay block source. Its blocks and declared heads are fixture assertions, not verified
 * chain state or verified finality; that provenance is preserved in the source identity. A future
 * live adapter implements the same {@link BlockSource} contract. The versioned file schema uses
 * decimal strings for heights/timestamps and rejects unsafe numeric JSON rather than rounding it.
 */

export const RECORDED_SCHEMA = "arena-indexer-recorded-v1";

export interface RecordedChainFile {
  schema: string;
  identity: SourceIdentity;
  latest: BlockRef | null;
  finalized: BlockRef | null;
  blocks: RecordedBlock[];
  /** Heights the source declares as legitimately skipped (no block). */
  skippedHeights?: string[];
  /** Heights the source declares it cannot fully serve yet (do not advance over them). */
  incompleteHeights?: string[];
}

export class RecordedChainError extends Error {
  constructor(reason: string) {
    super(`invalid recorded chain file: ${reason}`);
    this.name = "RecordedChainError";
  }
}

export class RecordedBlockSource implements BlockSource {
  private file: RecordedChainFile;
  private index = new Map<string, RecordedBlock>();
  private skipped = new Set<string>();
  private incomplete = new Set<string>();

  constructor(file: RecordedChainFile) {
    this.file = file;
    this.reindex();
  }

  /** Replace the underlying chain (used to simulate a reorg/fork in tests and future live catch-up). */
  replace(file: RecordedChainFile): void {
    this.file = file;
    this.reindex();
  }

  private reindex(): void {
    this.index = new Map(this.file.blocks.map((b) => [b.header.height, b]));
    this.skipped = new Set(this.file.skippedHeights ?? []);
    this.incomplete = new Set(this.file.incompleteHeights ?? []);
  }

  identity(): SourceIdentity {
    return this.file.identity;
  }

  async head(): Promise<{ latest: BlockRef | null; finalized: BlockRef | null }> {
    return { latest: this.file.latest, finalized: this.file.finalized };
  }

  async blockAt(height: string): Promise<BlockAt> {
    const block = this.index.get(height);
    if (block) return { kind: "block", block };
    if (this.incomplete.has(height)) return { kind: "incomplete" };
    if (this.skipped.has(height)) return { kind: "skipped" };
    if (this.file.latest && BigInt(height) > BigInt(this.file.latest.height)) return { kind: "beyond_head" };
    // A height below the latest head with no recorded block is a legitimate skipped NEAR height.
    return { kind: "skipped" };
  }
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;

function reqString(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0) throw new RecordedChainError(`${what} must be a non-empty string`);
  return v;
}

function reqDecimal(v: unknown, what: string): string {
  // Reject numbers outright: heights/timestamps must be decimal strings so a u64 never rounds.
  if (typeof v !== "string" || !DECIMAL.test(v)) throw new RecordedChainError(`${what} must be a decimal string`);
  return v;
}

function parseRef(v: unknown, what: string): BlockRef | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") throw new RecordedChainError(`${what} must be an object or null`);
  const r = v as Record<string, unknown>;
  return { height: reqDecimal(r.height, `${what}.height`), hash: reqString(r.hash, `${what}.hash`) };
}

function parseOutcome(v: unknown, what: string): ReceiptOutcome {
  if (!v || typeof v !== "object") throw new RecordedChainError(`${what} must be an object`);
  const o = v as Record<string, unknown>;
  if (typeof o.success !== "boolean") throw new RecordedChainError(`${what}.success must be a boolean`);
  if (!Array.isArray(o.logs) || !o.logs.every((l) => typeof l === "string")) {
    throw new RecordedChainError(`${what}.logs must be an array of strings`);
  }
  return {
    receiptId: reqString(o.receiptId, `${what}.receiptId`),
    executorId: o.executorId === undefined ? undefined : reqString(o.executorId, `${what}.executorId`),
    success: o.success,
    logs: o.logs as string[],
  };
}

function parseBlock(v: unknown, i: number): RecordedBlock {
  if (!v || typeof v !== "object") throw new RecordedChainError(`blocks[${i}] must be an object`);
  const b = v as Record<string, unknown>;
  const header = b.header as Record<string, unknown> | undefined;
  if (!header || typeof header !== "object") throw new RecordedChainError(`blocks[${i}].header must be an object`);
  if (!Array.isArray(b.outcomes)) throw new RecordedChainError(`blocks[${i}].outcomes must be an array`);
  if (typeof b.complete !== "boolean") throw new RecordedChainError(`blocks[${i}].complete must be a boolean`);
  const parentHash = header.parentHash;
  if (parentHash !== null && typeof parentHash !== "string") throw new RecordedChainError(`blocks[${i}].header.parentHash must be a string or null`);
  return {
    network: reqString(b.network, `blocks[${i}].network`),
    contract: reqString(b.contract, `blocks[${i}].contract`),
    header: {
      height: reqDecimal(header.height, `blocks[${i}].header.height`),
      hash: reqString(header.hash, `blocks[${i}].header.hash`),
      parentHash: parentHash as string | null,
      timestampMs: reqDecimal(header.timestampMs, `blocks[${i}].header.timestampMs`),
    },
    outcomes: b.outcomes.map((o, j) => parseOutcome(o, `blocks[${i}].outcomes[${j}]`)),
    complete: b.complete,
    finalizedDeclared: typeof b.finalizedDeclared === "boolean" ? b.finalizedDeclared : undefined,
  };
}

/** Validate a recorded chain file (schema, identity, blocks); throws `RecordedChainError`. */
export function validateRecordedChain(raw: unknown): RecordedChainFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RecordedChainError("not an object");
  const f = raw as Record<string, unknown>;
  if (f.schema !== RECORDED_SCHEMA) throw new RecordedChainError(`unsupported schema ${String(f.schema)}`);
  const id = f.identity as Record<string, unknown> | undefined;
  if (!id || typeof id !== "object") throw new RecordedChainError("identity must be an object");
  if (id.sourceType !== "recorded" && id.sourceType !== "live") throw new RecordedChainError("identity.sourceType must be recorded or live");
  const identity: SourceIdentity = {
    network: reqString(id.network, "identity.network"),
    sourceType: id.sourceType,
    genesis: id.genesis === undefined ? undefined : reqString(id.genesis, "identity.genesis"),
  };
  if (!Array.isArray(f.blocks)) throw new RecordedChainError("blocks must be an array");
  const dedupHeights = (v: unknown, what: string): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) throw new RecordedChainError(`${what} must be an array`);
    return v.map((h, i) => reqDecimal(h, `${what}[${i}]`));
  };
  return {
    schema: RECORDED_SCHEMA,
    identity,
    latest: parseRef(f.latest, "latest"),
    finalized: parseRef(f.finalized, "finalized"),
    blocks: f.blocks.map(parseBlock),
    skippedHeights: dedupHeights(f.skippedHeights, "skippedHeights"),
    incompleteHeights: dedupHeights(f.incompleteHeights, "incompleteHeights"),
  };
}
