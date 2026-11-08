// FIXTURE-ONLY: a real temp state directory; no network.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { config } from "./fixtures.js";

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
  cursors: { processedHead: { height: "1", hash: "h1" }, finalizedHead: { height: "1", hash: "h1" } },
  health: { status: "healthy", reason: "test fixture" },
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
});
