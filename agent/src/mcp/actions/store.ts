import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ActionRequest, Preview } from "./preview.js";

/**
 * Durable action identity and status. One versioned JSON file, written to a temp file and renamed
 * so a crash keeps the last committed state; writes are serialized within the process. A corrupt
 * or unsupported file fails closed and is never reset. Without a path the store is in memory
 * (tests only).
 */

export const ACTION_STORE_VERSION = "valtrum-actions-v1";
export const MAX_ACTIONS = 10_000;

export type ActionStatus =
  | "previewed"
  | "authorized"
  | "ready_to_sign"
  | "broadcast"
  | "confirmed"
  | "failed"
  | "rejected"
  | "expired";

export type ActionAuthorization =
  | { kind: "user_signature"; accountId: string; publicKey: string; atMs: number }
  | { kind: "grant"; delegate: string; user: string; atMs: number };

export interface ActionRecord {
  actionId: string;
  /** The verified session account that created the preview. */
  caller: string;
  request: ActionRequest;
  preview: Preview;
  previewHash: string;
  bindingHash: string;
  status: ActionStatus;
  authorization: ActionAuthorization | null;
  txHash: string | null;
  reason: string | null;
  history: { status: ActionStatus; atMs: number; note?: string }[];
}

interface StoreFile {
  version: string;
  actions: Record<string, ActionRecord>;
}

export class ActionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionStoreError";
  }
}

/** What the action service needs from a store. The file store below and the Postgres store both implement it. */
export interface ActionStorePort {
  get(actionId: string): Promise<ActionRecord | null>;
  /** Atomically reads, transforms and commits one record. `update` may throw to abort. */
  update(actionId: string, update: (current: ActionRecord | null) => ActionRecord): Promise<ActionRecord>;
}

export class ActionStore implements ActionStorePort {
  private actions: Map<string, ActionRecord> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string | null) {}

  private async load(): Promise<Map<string, ActionRecord>> {
    if (this.actions) return this.actions;
    if (!this.path) {
      this.actions = new Map();
      return this.actions;
    }
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.actions = new Map();
        return this.actions;
      }
      throw err;
    }
    let parsed: StoreFile;
    try {
      parsed = JSON.parse(text) as StoreFile;
    } catch {
      throw new ActionStoreError(`action store ${this.path} is corrupt; it is kept unchanged for inspection`);
    }
    if (parsed?.version !== ACTION_STORE_VERSION || typeof parsed.actions !== "object" || parsed.actions === null) {
      throw new ActionStoreError(`action store ${this.path} has an unsupported version`);
    }
    this.actions = new Map(Object.entries(parsed.actions));
    return this.actions;
  }

  private async persist(actions: Map<string, ActionRecord>): Promise<void> {
    if (!this.path) return;
    const body: StoreFile = { version: ACTION_STORE_VERSION, actions: Object.fromEntries(actions) };
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(body), "utf8");
    await rename(tmp, this.path);
  }

  async get(actionId: string): Promise<ActionRecord | null> {
    const actions = await this.load();
    const found = actions.get(actionId);
    return found ? structuredClone(found) : null;
  }

  /** Atomically reads, transforms and commits one record. `update` may throw to abort. */
  async update(actionId: string, update: (current: ActionRecord | null) => ActionRecord): Promise<ActionRecord> {
    const run = this.queue.then(async () => {
      const actions = await this.load();
      const current = actions.get(actionId) ?? null;
      const next = update(current ? structuredClone(current) : null);
      if (!current && actions.size >= MAX_ACTIONS) throw new ActionStoreError("action store is full");
      const copy = new Map(actions);
      copy.set(actionId, next);
      await this.persist(copy);
      this.actions = copy;
      return structuredClone(next);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
