// FIXTURE-ONLY: a fake neardata HTTP server (injected fetch). No network, no live chain, no provider proof.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexerEngine } from "../../src/indexer/engine.js";
import { NearDataBlockSource, NearDataError } from "../../src/indexer/live-source.js";
import { JsonFileIndexerStore } from "../../src/indexer/store.js";
import { createIndexerRuntime, loadIndexerRuntimeConfig } from "../../src/indexer/wiring.js";
import { created, deposit, emitLog } from "./fixtures.js";

const ARENA = "arena.testnet";
const LETTERS = "ABCDEFGHJK";
const hash = (h: number) => `Z${[...String(h)].map((d) => LETTERS[Number(d)]).join("")}`.padEnd(44, "Q");

interface FakeBlock {
  height: number;
  prev: number | null;
  outcomes?: { executor: string; receipt: string; logs: string[]; status?: unknown }[];
  shards?: unknown;
}

class FakeNearData {
  readonly blocks = new Map<number, FakeBlock>();
  finalHead = 0;
  readonly calls: string[] = [];
  readonly headers: (Record<string, string> | undefined)[] = [];
  failures = 0;
  redirectTo: string | null = null;
  add(b: FakeBlock) { this.blocks.set(b.height, b); return this; }
  private body(b: FakeBlock) {
    return {
      block: { author: "v", chunks: [], header: { height: b.height, hash: hash(b.height), prev_hash: hash(b.prev ?? 0), prev_height: b.prev, timestamp_nanosec: `${b.height}000000000000` } },
      shards: b.shards ?? [{ shard_id: 0, chunk: null, state_changes: [], receipt_execution_outcomes: (b.outcomes ?? []).map((o) => ({
        receipt: { receipt_id: o.receipt, receiver_id: o.executor, predecessor_id: "p.testnet" },
        execution_outcome: { outcome: { executor_id: o.executor, logs: o.logs, status: o.status ?? { SuccessValue: "" } } },
      })) }],
    };
  }
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    this.calls.push(url);
    this.headers.push(init?.headers as Record<string, string> | undefined);
    if (this.failures > 0) { this.failures--; return new Response("busy", { status: 503 }); }
    const path = new URL(url).pathname;
    if (path === "/v0/last_block/final") {
      if (this.redirectTo) return new Response(null, { status: 302, headers: { location: this.redirectTo } });
      return new Response(JSON.stringify(this.body(this.blocks.get(this.finalHead) as FakeBlock)), { status: 200 });
    }
    const m = /^\/v0\/block\/(\d+)$/.exec(path);
    if (!m) return new Response("nope", { status: 404 });
    const b = this.blocks.get(Number(m[1]));
    return new Response(b ? JSON.stringify(this.body(b)) : "null", { status: 200 });
  };
}

const source = (fake: FakeNearData, over: Partial<ConstructorParameters<typeof NearDataBlockSource>[0]> = {}) =>
  new NearDataBlockSource({ network: "testnet", contracts: [ARENA], fetchFn: fake.fetch, minIntervalMs: 0, sleep: async () => undefined, ...over });

describe("NearDataBlockSource", () => {
  it("is labeled live, serves finalized blocks only and filters to allowlisted executors", async () => {
    const fake = new FakeNearData();
    fake.add({ height: 5, prev: 4, outcomes: [
      { executor: ARENA, receipt: "r1", logs: [created(1)] },
      { executor: "other.testnet", receipt: "r2", logs: [created(2)] },
      { executor: ARENA, receipt: "r3", logs: ["x"], status: { Failure: {} } },
    ] }).add({ height: 4, prev: 3 });
    fake.finalHead = 5;
    const s = source(fake);
    expect(s.identity()).toEqual({ network: "near-testnet", sourceType: "live" });
    expect(await s.head()).toEqual({ latest: { height: "5", hash: hash(5) }, finalized: { height: "5", hash: hash(5) } });
    const at = await s.blockAt("5");
    expect(at.kind).toBe("block");
    if (at.kind !== "block") return;
    expect(at.block).toMatchObject({ network: "near-testnet", contract: ARENA, complete: true, header: { height: "5", hash: hash(5), parentHash: hash(4), timestampMs: "5000000" } });
    expect(at.block.outcomes.map((o) => [o.receiptId, o.executorId, o.success])).toEqual([["r1", ARENA, true], ["r3", ARENA, false]]);
    expect((await s.blockAt("6")).kind).toBe("beyond_head");
  });

  it("reports a height as skipped only when a later block proves it, otherwise incomplete", async () => {
    const fake = new FakeNearData();
    fake.add({ height: 3, prev: 2 }).add({ height: 5, prev: 3 }).add({ height: 8, prev: 7 }).add({ height: 9, prev: 8 });
    fake.finalHead = 9;
    const s = source(fake);
    expect((await s.blockAt("4")).kind).toBe("skipped"); // block 5 says its parent is 3
    expect((await s.blockAt("6")).kind).toBe("incomplete"); // block 8 says its parent is 7, so 6/7 are not proven skipped... 7 exists
    expect((await s.blockAt("7")).kind).toBe("incomplete"); // 7 exists (block 8's parent) but the provider returned null
  });

  it("is incomplete when no later block can prove a gap, and when a shard has no outcome list", async () => {
    const fake = new FakeNearData();
    fake.add({ height: 9, prev: 8 });
    fake.finalHead = 9;
    expect((await source(fake, { skipProbe: 2 }).blockAt("7")).kind).toBe("incomplete");
    fake.add({ height: 9, prev: 8, shards: [{ shard_id: 0 }] });
    expect((await source(fake).blockAt("9")).kind).toBe("incomplete");
  });

  it("rejects a block whose height differs from the request and malformed hashes", async () => {
    const fake = new FakeNearData();
    fake.add({ height: 5, prev: 4 });
    fake.finalHead = 5;
    const lying: typeof fetch = async (input, init) => {
      const res = await fake.fetch(input, init);
      const text = await res.text();
      return new Response(text.replace(/"height":5/, '"height":6'), { status: 200 });
    };
    await expect(source(fake, { fetchFn: lying }).blockAt("5")).rejects.toThrow(/provider returned height/);
    const bad: typeof fetch = async (input, init) => new Response((await (await fake.fetch(input, init)).text()).replace(hash(5), "not-a-hash"), { status: 200 });
    await expect(source(fake, { fetchFn: bad }).head()).rejects.toThrow(NearDataError);
  });

  it("retries 5xx a bounded number of times and then reports unavailable", async () => {
    const fake = new FakeNearData();
    fake.add({ height: 1, prev: null });
    fake.finalHead = 1;
    fake.failures = 2;
    expect((await source(fake).head()).finalized?.height).toBe("1");
    fake.failures = 99;
    await expect(source(fake, { retries: 2 }).head()).rejects.toThrow(/unavailable after retries/);
  });

  it("follows provider redirects only to provider hosts and never forwards the API key", async () => {
    const fake = new FakeNearData();
    fake.add({ height: 1, prev: null });
    fake.finalHead = 1;
    fake.redirectTo = "https://evil.example/v0/block/1";
    await expect(source(fake, { apiKey: "secret-key" }).head()).rejects.toThrow(/unexpected host/);
    expect(fake.headers[0]?.authorization).toBe("Bearer secret-key");
    fake.redirectTo = "https://archive.neardata.xyz/v0/block/1";
    const calls: (Record<string, string> | undefined)[] = [];
    const s = source(fake, { apiKey: "secret-key", fetchFn: async (i, init) => { calls.push(init?.headers as Record<string, string> | undefined); return fake.fetch(i, init); } });
    await s.head().catch(() => undefined);
    expect(calls.slice(1).every((h) => h?.authorization === undefined)).toBe(true);
  });

  it("requires https and a contract allowlist", () => {
    const fake = new FakeNearData();
    expect(() => source(fake, { baseUrl: "http://x" })).toThrow(/https/);
    expect(() => source(fake, { contracts: [] })).toThrow(/allowlisted/);
  });
});

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "indexer-live-")); });
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("indexer engine over the live source", () => {
  it("indexes finalized blocks, resumes after restart and degrades on an unavailable provider", async () => {
    const fake = new FakeNearData();
    fake.add({ height: 1, prev: 0, outcomes: [{ executor: ARENA, receipt: "r1", logs: [created(1)] }] })
      .add({ height: 2, prev: 1, outcomes: [{ executor: ARENA, receipt: "r2", logs: [deposit(1, 0, "bob.testnet", "10")] }] })
      .add({ height: 4, prev: 2, outcomes: [{ executor: ARENA, receipt: "r4", logs: [emitLog("mystery_event", { a: 1 })] }] });
    fake.finalHead = 2;
    const cfg = { network: "near-testnet", contracts: [ARENA], standard: "valtrum", supportedVersions: ["1.0.0"], schemaVersion: "indexer-v1", reducerVersion: "projection-v1", anchorHash: hash(0), anchorHeight: "1", retainedDepth: 1024 };
    const store = () => new JsonFileIndexerStore(join(dir, "state"));
    let engine = new IndexerEngine(source(fake), store(), cfg, { maxBlocksPerSync: 50 });
    await engine.open();
    const first = await engine.sync();
    expect(first).toMatchObject({ status: "healthy", processedHead: { height: "2" }, source: { sourceType: "live", network: "near-testnet" } });
    await engine.close();

    // Restart: the same state continues; height 3 is a proven skip and height 4 holds an unknown event.
    fake.finalHead = 4;
    engine = new IndexerEngine(source(fake), store(), cfg, { maxBlocksPerSync: 50 });
    await engine.open();
    const next = await engine.sync();
    expect(next.processedHead?.height).toBe("4");
    expect(next.status).toBe("degraded"); // the unknown allowlisted event is reported, not dropped
    expect(next.quarantined).toBe(1);

    // A provider outage rejects the sync (the runtime reports it as unavailable) and keeps stored state.
    fake.failures = 99;
    await expect(engine.sync()).rejects.toThrow(/unavailable after retries/);
    fake.failures = 0;
    expect((await engine.sync()).processedHead?.height).toBe("4");
    await engine.close();
  });
});

describe("live indexer runtime config", () => {
  const base = { INDEXER_ENABLED: "true", INDEXER_SOURCE: "live", INDEXER_ANCHOR_HEIGHT: "100", INDEXER_ANCHOR_HASH: hash(99) };

  it("needs an explicit anchor, never mixes in a recorded file and keeps recorded as the default", () => {
    expect(loadIndexerRuntimeConfig(base, ARENA)).toMatchObject({ source: "live", anchorHeight: "100", live: { network: "testnet", maxBlocksPerSync: 200 } });
    expect(() => loadIndexerRuntimeConfig({ ...base, INDEXER_ANCHOR_HEIGHT: undefined }, ARENA)).toThrow(/INDEXER_ANCHOR_HEIGHT/);
    expect(() => loadIndexerRuntimeConfig({ ...base, INDEXER_ANCHOR_HASH: undefined }, ARENA)).toThrow(/INDEXER_ANCHOR_HASH/);
    expect(() => loadIndexerRuntimeConfig({ ...base, INDEXER_RECORDED_CHAIN: "chain.json" }, ARENA)).toThrow(/never mixed|must not be set/);
    expect(() => loadIndexerRuntimeConfig({ ...base, INDEXER_NEARDATA_URL: "http://x" }, ARENA)).toThrow(/https/);
    expect(() => loadIndexerRuntimeConfig({ ...base, INDEXER_MAX_BLOCKS_PER_SYNC: "0" }, ARENA)).toThrow(/INDEXER_MAX_BLOCKS_PER_SYNC/);
    expect(() => loadIndexerRuntimeConfig({ INDEXER_ENABLED: "true", INDEXER_SOURCE: "x" }, ARENA)).toThrow(/INDEXER_SOURCE/);
    expect(loadIndexerRuntimeConfig({ INDEXER_ENABLED: "true", INDEXER_RECORDED_CHAIN: "c.json" }, ARENA)?.source).toBe("recorded");
  });

  it("does not put the API key in the logged runtime settings", async () => {
    const logs: string[] = [];
    const log = { info: (m: string, f?: unknown) => logs.push(m + JSON.stringify(f)), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
    const cfg = loadIndexerRuntimeConfig({ ...base, INDEXER_STATE_DIR: join(dir, "s"), INDEXER_NEARDATA_API_KEY: "secret-key" }, ARENA);
    const rt = await createIndexerRuntime(cfg!, log);
    await rt.close();
    expect(logs.join("\n")).toMatch(/LIVE neardata/);
    expect(logs.join("\n")).not.toMatch(/secret-key/);
  });
});
