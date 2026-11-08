import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AcceptedEvent, BlockRef, DiagnosticRecord, IndexerConfig } from "./types.js";

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

export interface StoreState {
  schema: string;
  config: IndexerConfig;
  /** Processed chain in ascending height order (finalized prefix then provisional tail). */
  blocks: StoredBlock[];
  /** Accepted events; order is not relied upon (the reducer sorts canonically). */
  journal: AcceptedEvent[];
  diagnostics: DiagnosticRecord[];
  cursors: { processedHead: BlockRef | null; finalizedHead: BlockRef | null };
}

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

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface IndexerStoreOptions {
  lockStaleMs?: number;
}

export class JsonFileIndexerStore {
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly lockStaleMs: number;
  private locked = false;

  constructor(private readonly dir: string, opts: IndexerStoreOptions = {}) {
    this.statePath = join(dir, "state.json");
    this.lockPath = join(dir, "state.lock");
    this.lockStaleMs = opts.lockStaleMs ?? 30_000;
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
    return s as StoreState;
  }

  /** Acquire the single-writer lock, then load or establish state. Validates config compatibility. */
  async open(config: IndexerConfig): Promise<StoreState> {
    await this.acquire();
    try {
      const existing = await this.read();
      if (!existing) {
        return { schema: STORE_SCHEMA, config, blocks: [], journal: [], diagnostics: [], cursors: { processedHead: null, finalizedHead: null } };
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
    if (state.diagnostics.length > MAX_DIAGNOSTICS) throw new StoreLimitError("diagnostics");
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
      // Break only a lock abandoned by a crashed writer (older than the stale window).
      try {
        const st = await stat(this.lockPath);
        if (Date.now() - st.mtimeMs > this.lockStaleMs) {
          await unlink(this.lockPath).catch(() => undefined);
          await delay(5);
          return this.acquire();
        }
      } catch {
        return this.acquire();
      }
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
