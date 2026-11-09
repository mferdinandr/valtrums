// FIXTURE-ONLY: a real temp state directory; no network.
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JsonFileIndexerStore,
  STORE_SCHEMA,
  StoreConfigConflictError,
  StoreCorruptError,
  StoreLockedError,
  type StoreState,
} from "../../src/indexer/store.js";
import { parseBlock } from "../../src/indexer/parser.js";
import { block, config, deposit, outcome } from "./fixtures.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "indexer-store-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const freshState = (cfg = config()): StoreState => ({
  schema: STORE_SCHEMA,
  config: cfg,
  blocks: [{ height: "1", hash: "h1", parentHash: null, timestampMs: "1700000000000", finalized: true }],
  journal: [],
  diagnostics: [],
  diagnosticsDropped: 0,
  ignoredLogs: 0,
  conflictBlocks: [],
  diagnosticOverflowBlocks: [],
  cursors: { processedHead: { height: "1", hash: "h1" }, finalizedHead: { height: "1", hash: "h1" } },
  health: { status: "healthy", reason: "test fixture" },
  reorgSuspension: null,
  checkpoint: null,
});

describe("JsonFileIndexerStore recovery", () => {
  it("distinguishes missing initial state from corrupt state", async () => {
    const s = new JsonFileIndexerStore(dir);
    expect(await s.read()).toBeNull(); // missing: not an error
    await writeFile(join(dir, "state.json"), "{not json", "utf8");
    await expect(s.read()).rejects.toBeInstanceOf(StoreCorruptError);
  });

  it("preserves a corrupt file instead of resetting it", async () => {
    const path = join(dir, "state.json");
    await writeFile(path, "{broken", "utf8");
    await expect(new JsonFileIndexerStore(dir).read()).rejects.toBeInstanceOf(StoreCorruptError);
    expect(await readFile(path, "utf8")).toBe("{broken"); // untouched for diagnosis
  });

  it("rejects an unsupported schema", async () => {
    await writeFile(join(dir, "state.json"), JSON.stringify({ schema: "other", config: {}, blocks: [], journal: [], diagnostics: [], cursors: {} }), "utf8");
    await expect(new JsonFileIndexerStore(dir).read()).rejects.toBeInstanceOf(StoreCorruptError);
  });

  it("round-trips committed state atomically", async () => {
    const s = new JsonFileIndexerStore(dir);
    await s.open(config());
    await s.commit(freshState());
    await s.close();
    const back = await new JsonFileIndexerStore(dir).read();
    expect(back?.cursors.processedHead).toEqual({ height: "1", hash: "h1" });
  });
});

describe("JsonFileIndexerStore configuration and exclusivity", () => {
  it("rejects reopening under a conflicting configuration", async () => {
    const s = new JsonFileIndexerStore(dir);
    await s.open(config());
    await s.commit(freshState());
    await s.close();
    const s2 = new JsonFileIndexerStore(dir);
    await expect(s2.open(config({ reducerVersion: "projection-v2" }))).rejects.toBeInstanceOf(StoreConfigConflictError);
    const s3 = new JsonFileIndexerStore(dir);
    await expect(s3.open(config({ contracts: ["other.testnet"] }))).rejects.toBeInstanceOf(StoreConfigConflictError);
  });

  it("enforces a single writer and releases on close", async () => {
    const a = new JsonFileIndexerStore(dir, { lockStaleMs: 10_000 });
    await a.open(config());
    const b = new JsonFileIndexerStore(dir, { lockStaleMs: 10_000 });
    await expect(b.open(config())).rejects.toBeInstanceOf(StoreLockedError);
    await a.close();
    const c = new JsonFileIndexerStore(dir, { lockStaleMs: 10_000 });
    await expect(c.open(config())).resolves.toBeTruthy(); // lock released
    await c.close();
  });

  it("refuses to commit without holding the lock", async () => {
    const s = new JsonFileIndexerStore(dir);
    await expect(s.commit(freshState())).rejects.toThrow(/writer lock/);
  });

  it("never steals an aged lock from a still-running writer", async () => {
    const a = new JsonFileIndexerStore(dir, { lockStaleMs: 1 });
    await a.open(config());
    const old = new Date(0);
    await utimes(join(dir, "state.lock"), old, old);
    const b = new JsonFileIndexerStore(dir, { lockStaleMs: 1 });
    await expect(b.open(config())).rejects.toBeInstanceOf(StoreLockedError);
    await a.commit(freshState());
    await a.close();
    await expect(b.open(config())).resolves.toBeTruthy();
    await b.close();
  });
});

describe("semantic snapshot integrity", () => {
  const withDeposit = (): StoreState => {
    const state = freshState();
    const blk = block({ height: "1", hash: "h1", timestampMs: state.blocks[0]!.timestampMs, outcomes: [outcome("r1", [deposit(1, 0, "alice.testnet", "100")])] });
    state.journal = parseBlock(blk, config()).accepted;
    return state;
  };

  it("rejects changed journal payloads whose stored digest no longer matches", async () => {
    const state = withDeposit();
    const event = state.journal[0]!;
    if (event.name !== "lifecycle_deposit") throw new Error("expected deposit fixture");
    event.amount = "1";
    const encoded = JSON.stringify(state);
    await writeFile(join(dir, "state.json"), encoded);
    await expect(new JsonFileIndexerStore(dir).read()).rejects.toThrow(/digest mismatch/);
    expect(await readFile(join(dir, "state.json"), "utf8")).toBe(encoded);
  });

  it.each([
    ["duplicate blocks", (s: StoreState) => s.blocks.push({ ...s.blocks[0]! })],
    ["cursor mismatch", (s: StoreState) => { s.cursors.processedHead!.height = "9"; }],
    ["finality mismatch", (s: StoreState) => { s.blocks[0]!.finalized = false; }],
    ["duplicate events", (s: StoreState) => s.journal.push({ ...s.journal[0]! })],
    ["wrong provenance", (s: StoreState) => { s.journal[0]!.provenance.blockHash = "absent"; }],
    ["wrong event key", (s: StoreState) => { s.journal[0]!.dedupKey = "wrong"; }],
    ["unknown health", (s: StoreState) => { (s.health as { status: string }).status = "fine"; }],
    ["invalid counter", (s: StoreState) => { s.diagnosticsDropped = -1; }],
  ] as const)("rejects %s", async (_name, corrupt) => {
    const state = withDeposit();
    corrupt(state);
    await writeFile(join(dir, "state.json"), JSON.stringify(state));
    await expect(new JsonFileIndexerStore(dir).read()).rejects.toBeInstanceOf(StoreCorruptError);
  });
});
