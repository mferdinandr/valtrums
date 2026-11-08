// FIXTURE-ONLY: recorded sources and a real temp state directory; no live RPC, no write transport.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexerEngine } from "../../src/indexer/engine.js";
import { RecordedBlockSource } from "../../src/indexer/recorded-source.js";
import { JsonFileIndexerStore, StoreLockedError } from "../../src/indexer/store.js";
import type { BlockSource } from "../../src/indexer/types.js";
import { auditUpdated, block, chainFile, config, created, deposit, emitLog, linked, outcome } from "./fixtures.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "indexer-engine-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const store = () => new JsonFileIndexerStore(dir, { lockStaleMs: 10_000 });

async function engineOn(source: BlockSource, opts: { maxBlocksPerSync?: number } = {}) {
  const s = store();
  const engine = new IndexerEngine(source, s, config(), { now: () => 1000, maxBlocksPerSync: opts.maxBlocksPerSync });
  await engine.open();
  return { engine, s };
}

// A battle with a created event, one audit and three deposits across heights 1..5.
const baseChain = () =>
  linked([
    { height: "1", outcomes: [outcome("r1", [created(1, "alice.testnet")])] },
    { height: "2", outcomes: [outcome("r2", [auditUpdated(1, 0, "pass")])] },
    { height: "3", outcomes: [outcome("r3", [deposit(1, 0, "bob.testnet", "100")])] },
    { height: "4", outcomes: [outcome("r4", [deposit(1, 0, "bob.testnet", "200")])] },
    { height: "5", outcomes: [outcome("r5", [deposit(1, 0, "bob.testnet", "300")])] },
  ]);

describe("engine ingest and finality", () => {
  it("ingests supported events and labels provisional vs finalized", async () => {
    const { engine } = await engineOn(new RecordedBlockSource(chainFile(baseChain(), { finalizedHeight: "2" })));
    const health = await engine.sync();
    expect(health.status).toBe("healthy");
    expect(health.processedHead?.height).toBe("5");
    expect(health.finalizedHead?.height).toBe("2");
    const battle = engine.projection().battles[`${config().network}|${config().contracts[0]}|1`]!;
    expect(battle.creator).toBe("alice.testnet");
    expect(battle.creditedByCommunity["0"]).toBe("600");
    expect(battle.created?.finalized).toBe(true);
    expect(battle.deposits.every((d) => d.ref.finalized)).toBe(false);
    await engine.close();
  });

  it("holds pending while the source declares no finalized head", async () => {
    const { engine } = await engineOn(new RecordedBlockSource(chainFile(baseChain(), { finalizedHeight: undefined })));
    const health = await engine.sync();
    expect(health.status).toBe("pending");
    await engine.close();
  });
});

describe("engine determinism and restart", () => {
  it("produces the same projection incrementally, in one batch, and on re-sync", async () => {
    const digests: string[] = [];
    for (const max of [1, 100]) {
      const d = await mkdtemp(join(tmpdir(), "indexer-det-"));
      const s = new JsonFileIndexerStore(d);
      const engine = new IndexerEngine(new RecordedBlockSource(chainFile(baseChain(), { finalizedHeight: "5" })), s, config(), { now: () => 1, maxBlocksPerSync: max });
      await engine.open();
      // Drain to the head regardless of batch size, then re-sync once (idempotent).
      for (let i = 0; i < 10 && engine.health().processedHead?.height !== "5"; i++) await engine.sync();
      await engine.sync();
      digests.push(engine.projection().digest);
      await engine.close();
      await rm(d, { recursive: true, force: true });
    }
    expect(digests[0]).toBe(digests[1]);
  });

  it("recovers the committed cursor and projection after restart, then advances", async () => {
    const source = new RecordedBlockSource(chainFile(baseChain().slice(0, 3), { finalizedHeight: "2" }));
    const first = await engineOn(source);
    await first.engine.sync();
    const digestA = first.engine.projection().digest;
    await first.engine.close();

    // Restart on the same directory: state is loaded, not rebuilt from scratch.
    const second = await engineOn(source);
    expect(second.engine.projection().digest).toBe(digestA);
    expect(second.engine.health().processedHead?.height).toBe("3");

    // Extend the source and continue from the persisted cursor.
    source.replace(chainFile(baseChain(), { finalizedHeight: "2" }));
    const health = await second.engine.sync();
    expect(health.processedHead?.height).toBe("5");
    await second.engine.close();
  });
});

describe("engine reorg and finality conflicts", () => {
  it("replaces a provisional fork and replays the canonical branch exactly once", async () => {
    const source = new RecordedBlockSource(chainFile(baseChain(), { finalizedHeight: "2" }));
    const { engine } = await engineOn(source);
    await engine.sync();
    expect(engine.projection().battles[`${config().network}|${config().contracts[0]}|1`]!.creditedByCommunity["0"]).toBe("600");

    // Fork at height 3: keep 1-2, replace 3-5 with new hashes and smaller deposits.
    const forked = linked([
      { height: "1", outcomes: [outcome("r1", [created(1, "alice.testnet")])] },
      { height: "2", outcomes: [outcome("r2", [auditUpdated(1, 0, "pass")])] },
      { height: "3", hash: "blk3b", outcomes: [outcome("r3b", [deposit(1, 0, "bob.testnet", "1")])] },
      { height: "4", hash: "blk4b", outcomes: [outcome("r4b", [deposit(1, 0, "bob.testnet", "2")])] },
      { height: "5", hash: "blk5b", outcomes: [outcome("r5b", [deposit(1, 0, "bob.testnet", "3")])] },
    ]);
    source.replace(chainFile(forked, { finalizedHeight: "2" }));
    const health = await engine.sync();
    expect(health.status).toBe("healthy");
    const battle = engine.projection().battles[`${config().network}|${config().contracts[0]}|1`]!;
    expect(battle.creditedByCommunity["0"]).toBe("6"); // old 600 fully retracted, new branch applied once
    expect(battle.deposits).toHaveLength(3);
    await engine.close();
  });

  it("requires reconciliation and does not rewrite a finalized block on a finalized conflict", async () => {
    const source = new RecordedBlockSource(chainFile(baseChain().slice(0, 4), { finalizedHeight: "3" }));
    const { engine } = await engineOn(source);
    await engine.sync();
    expect(engine.health().finalizedHead).toEqual({ height: "3", hash: "blk3" });

    // The source now finalizes a different block 3 (blk3b) and drops block 4.
    const conflicting = linked([
      { height: "1", outcomes: [outcome("r1", [created(1, "alice.testnet")])] },
      { height: "2", outcomes: [outcome("r2", [auditUpdated(1, 0, "pass")])] },
      { height: "3", hash: "blk3b", outcomes: [outcome("r3b", [deposit(1, 0, "bob.testnet", "9")])] },
    ]);
    source.replace(chainFile(conflicting, { finalizedHeight: "3" }));
    const health = await engine.sync();
    expect(health.status).toBe("reconciliation_required");
    // The committed finalized block is preserved, not rewritten to the conflicting one.
    expect(engine.health().finalizedHead).toEqual({ height: "3", hash: "blk3" });
    await engine.close();
  });

  it("stays degraded and keeps committed finality when the source finality regresses", async () => {
    const source = new RecordedBlockSource(chainFile(baseChain(), { finalizedHeight: "4" }));
    const { engine } = await engineOn(source);
    await engine.sync();
    expect(engine.health().finalizedHead?.height).toBe("4");
    source.replace(chainFile(baseChain(), { finalizedHeight: "2" })); // regressed finality
    const health = await engine.sync();
    expect(health.status).toBe("degraded");
    expect(engine.health().finalizedHead?.height).toBe("4"); // not un-finalized
    await engine.close();
  });
});

describe("engine coverage gaps and conflicts", () => {
  it("does not advance over incomplete coverage", async () => {
    const chain = baseChain();
    const source = new RecordedBlockSource(chainFile(chain, { finalizedHeight: "1", incomplete: ["2"], latest: { height: "5", hash: "blk5" } }));
    // Remove block 2 so it is only known as incomplete.
    const withoutTwo = chainFile(chain.filter((b) => b.header.height !== "2"), { finalizedHeight: "1", incomplete: ["2"], latest: { height: "5", hash: "blk5" } });
    source.replace(withoutTwo);
    const { engine } = await engineOn(source);
    const health = await engine.sync();
    expect(health.status).toBe("pending");
    expect(health.processedHead?.height).toBe("1"); // stopped at the incomplete gap, did not jump to 3
    await engine.close();
  });

  it("processes legitimate skipped heights through parent linkage", async () => {
    const chain = linked([
      { height: "1", outcomes: [outcome("r1", [created(1, "alice.testnet")])] },
      { height: "3", outcomes: [outcome("r3", [auditUpdated(1, 0, "pass")])] },
      { height: "5", outcomes: [outcome("r5", [deposit(1, 0, "bob.testnet", "50")])] },
    ]);
    const source = new RecordedBlockSource(chainFile(chain, { finalizedHeight: "3", skipped: ["2", "4"] }));
    const { engine } = await engineOn(source);
    const health = await engine.sync();
    expect(health.status).toBe("healthy");
    expect(health.processedHead?.height).toBe("5");
    await engine.close();
  });

  it("detects a conflicting payload under the same event identity", async () => {
    const chain = linked([
      { height: "1", outcomes: [outcome("r1", [created(1, "alice.testnet")])] },
      // Same receipt id r1 reused at height 2 with a different payload: same dedup key, new digest.
      { height: "2", outcomes: [outcome("r1", [created(1, "mallory.testnet")])] },
    ]);
    const { engine } = await engineOn(new RecordedBlockSource(chainFile(chain, { finalizedHeight: "1" })));
    const health = await engine.sync();
    expect(health.status).toBe("reconciliation_required");
    // The first, committed event is kept; the conflicting one is not applied.
    expect(engine.projection().battles[`${config().network}|${config().contracts[0]}|1`]!.creator).toBe("alice.testnet");
    await engine.close();
  });

  it("quarantines a malformed supported event and reports degraded, not healthy", async () => {
    const chain = linked([
      { height: "1", outcomes: [outcome("r1", [created(1, "alice.testnet")])] },
      { height: "2", outcomes: [outcome("r2", ['EVENT_JSON:{"standard":"valtrum","version":"1.0.0","event":"audit_updated","data":[{"battle_id":1,"community":0,"result":"maybe","evidence_hash":"x"}]}'])] },
    ]);
    const { engine } = await engineOn(new RecordedBlockSource(chainFile(chain, { finalizedHeight: "2" })));
    const health = await engine.sync();
    expect(health.status).toBe("degraded");
    expect(health.quarantined).toBe(1);
    await engine.close();
  });
});

describe("engine health persistence and coverage (review #59)", () => {
  it("reports pending, not healthy, before the first sync", async () => {
    const { engine } = await engineOn(new RecordedBlockSource(chainFile(baseChain(), { finalizedHeight: "2" })));
    expect(engine.health().status).toBe("pending");
    await engine.close();
  });

  it("persists a non-healthy status across a restart instead of reporting healthy", async () => {
    // A broken parent link requires reconciliation — a transient flag, not a stored diagnostic — so a
    // restart that re-derived status from diagnostics alone would wrongly report healthy.
    const broken = [
      block({ height: "1", hash: "blk1", parentHash: null, outcomes: [outcome("r1", [created(1, "alice.testnet")])] }),
      block({ height: "2", hash: "blk2", parentHash: "not-blk1", outcomes: [outcome("r2", [auditUpdated(1, 0, "pass")])] }),
    ];
    const source = new RecordedBlockSource(chainFile(broken, { finalizedHeight: "1" }));
    const first = await engineOn(source);
    expect((await first.engine.sync()).status).toBe("reconciliation_required");
    await first.engine.close();

    const second = await engineOn(source); // reopen the same state directory
    expect(second.engine.health().status).toBe("reconciliation_required");
    await second.engine.close();
  });

  it("does not advance over a block the source marks incomplete", async () => {
    const chain = linked([
      { height: "1", outcomes: [outcome("r1", [created(1, "alice.testnet")])] },
      { height: "2", outcomes: [outcome("r2", [auditUpdated(1, 0, "pass")])] },
      { height: "3", outcomes: [outcome("r3", [deposit(1, 0, "bob.testnet", "100")])] },
    ]);
    chain[1] = { ...chain[1]!, complete: false }; // block 2 is present but its data is not fully available
    const source = new RecordedBlockSource(chainFile(chain, { finalizedHeight: "1", latest: { height: "3", hash: "blk3" } }));
    const { engine } = await engineOn(source);
    const health = await engine.sync();
    expect(health.status).toBe("pending");
    expect(health.processedHead?.height).toBe("1"); // stopped before the incomplete block, never applied it
    const key = `${config().network}|${config().contracts[0]}|1`;
    expect(engine.projection().battles[key]!.audits).toHaveLength(0); // block 2's audit was not projected
    await engine.close();
  });

  it("degrades when an allowlisted emitter emits an event the indexer does not model", async () => {
    const chain = linked([
      { height: "1", outcomes: [outcome("r1", [created(1, "alice.testnet")])] },
      // backing_updated is a real event added in a later PR that this indexer version does not handle.
      { height: "2", outcomes: [outcome("r2", [emitLog("backing_updated", { battle_id: 1, community: 0, amount: "5" })])] },
    ]);
    const { engine } = await engineOn(new RecordedBlockSource(chainFile(chain, { finalizedHeight: "2" })));
    const health = await engine.sync();
    expect(health.status).toBe("degraded"); // a coverage gap is visible, not silently healthy
    expect(health.quarantined).toBe(1);
    await engine.close();
  });

  it("does not let an untrusted foreign-log flood poison health", async () => {
    // An untrusted account emits many well-formed logs. They are never our state, so even a flood far
    // past the cap must not degrade the indexer or occupy quarantine.
    const foreign = Array.from({ length: 5 }, (_, i) => created(1, `acct${i}.testnet`));
    const chain = linked([{ height: "1", outcomes: [outcome("r1", foreign, { executorId: "evil.testnet" })] }]);
    const source = new RecordedBlockSource(chainFile(chain, { finalizedHeight: "1" }));
    const engine = new IndexerEngine(source, store(), config(), { now: () => 1, maxDiagnostics: 2 });
    await engine.open();
    const health = await engine.sync();
    expect(health.status).toBe("healthy"); // foreign spam cannot force degraded
    expect(health.quarantined).toBe(0); // foreign logs are counted, not stored
    await engine.close();
  });

  it("caps attention quarantine and degrades when allowlisted integrity gaps overflow", async () => {
    // Five unmodelled events from the allowlisted emitter: all degrading. With a tiny cap the engine
    // keeps the most recent and counts the rest, so health degrades and commit never wedges.
    const unknowns = Array.from({ length: 5 }, (_, i) => emitLog("mystery_event", { x: i }));
    const chain = linked([{ height: "1", outcomes: [outcome("r1", unknowns)] }]);
    const source = new RecordedBlockSource(chainFile(chain, { finalizedHeight: "1" }));
    const engine = new IndexerEngine(source, store(), config(), { now: () => 1, maxDiagnostics: 2 });
    await engine.open();
    const health = await engine.sync();
    expect(health.quarantined).toBe(2); // capped, not five
    expect(health.status).toBe("degraded");
    await engine.close();

    const second = await engineOn(source); // the capped state committed without a StoreLimitError wedge
    expect(second.engine.health().status).toBe("degraded");
    await second.engine.close();
  });

  it("does not let a foreign-log flood evict a prior conflict or downgrade reconciliation", async () => {
    // Block 2 both conflicts with block 1's event (same dedup key, new payload) and carries a flood of
    // foreign logs. The conflict must survive and the status must stay reconciliation_required.
    const foreign = Array.from({ length: 5 }, (_, i) => created(1, `acct${i}.testnet`));
    const chain = linked([
      { height: "1", outcomes: [outcome("r1", [created(1, "alice.testnet")])] },
      {
        height: "2",
        outcomes: [
          outcome("r1", [created(1, "mallory.testnet")]), // same dedup key as block 1 -> conflict_payload
          outcome("rF", foreign, { executorId: "evil.testnet" }),
        ],
      },
    ]);
    const source = new RecordedBlockSource(chainFile(chain, { finalizedHeight: "1" }));
    const engine = new IndexerEngine(source, store(), config(), { now: () => 1, maxDiagnostics: 2 });
    await engine.open();
    const health = await engine.sync();
    expect(health.status).toBe("reconciliation_required"); // not downgraded to degraded
    expect(health.quarantined).toBe(1); // the conflict survived; foreign logs did not evict it
    await engine.close();
  });
});

describe("engine durability and exclusivity", () => {
  it("serializes overlapping sync calls without duplicate blocks or competing commits", async () => {
    const source = new RecordedBlockSource(chainFile(baseChain(), { finalizedHeight: "2" }));
    const { engine } = await engineOn(source);
    const results = await Promise.all([engine.sync(), engine.sync(), engine.sync()]);
    expect(results.every((h) => h.status === "healthy")).toBe(true);
    await engine.close();
    const persisted = await store().read();
    expect(persisted!.blocks.map((b) => b.height)).toEqual(["1", "2", "3", "4", "5"]);
    expect(persisted!.journal).toHaveLength(5);
  });

  it("waits for queued syncs before close and rejects new work while closing", async () => {
    const original = new RecordedBlockSource(chainFile(baseChain(), { finalizedHeight: "2" }));
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const source: BlockSource = {
      identity: () => original.identity(),
      head: async () => {
        if (first) { first = false; enter(); await gate; }
        return original.head();
      },
      blockAt: (h) => original.blockAt(h),
    };
    const { engine } = await engineOn(source);
    const sync = engine.sync();
    const queued = engine.sync();
    await entered;
    const closing = engine.close();
    await expect(engine.sync()).rejects.toThrow(/not open/);
    await expect(store().open(config())).rejects.toBeInstanceOf(StoreLockedError);
    release();
    await Promise.all([sync, queued, closing, engine.close()]);
    const next = await engineOn(original);
    expect(next.engine.health().processedHead?.height).toBe("5");
    await next.engine.close();
  });

  it("rejects a second concurrent writer on the same state directory", async () => {
    const source = new RecordedBlockSource(chainFile(baseChain(), { finalizedHeight: "2" }));
    const first = await engineOn(source);
    const second = new IndexerEngine(source, store(), config(), {});
    await expect(second.open()).rejects.toBeInstanceOf(StoreLockedError);
    await first.engine.close();
  });

  it("keeps the last committed state when a later sync fails before commit", async () => {
    const source = new RecordedBlockSource(chainFile(baseChain().slice(0, 2), { finalizedHeight: "2" }));
    const first = await engineOn(source);
    await first.engine.sync(); // commits heights 1-2
    await first.engine.close();

    // A source that throws mid-read: the sync rejects before committing.
    const boom: BlockSource = {
      identity: () => source.identity(),
      head: async () => ({ latest: { height: "5", hash: "blk5" }, finalized: { height: "2", hash: "blk2" } }),
      blockAt: async (h) => {
        if (h === "3") throw new Error("source read failed");
        return source.blockAt(h);
      },
    };
    const second = await engineOn(boom);
    await expect(second.engine.sync()).rejects.toThrow(/source read failed/);
    await second.engine.close();

    // Reopen: the committed state is still heights 1-2, nothing partially applied.
    const third = await engineOn(source);
    expect(third.engine.health().processedHead?.height).toBe("2");
    await third.engine.close();
  });

  it("exposes no write or signing transport (read-only dependencies)", () => {
    const source = new RecordedBlockSource(chainFile(baseChain(), {})) as unknown as Record<string, unknown>;
    for (const m of ["call", "sign", "sendTransaction", "submit"]) expect(source[m]).toBeUndefined();
    const engine = new IndexerEngine(new RecordedBlockSource(chainFile(baseChain(), {})), store(), config(), {}) as unknown as Record<string, unknown>;
    for (const m of ["call", "sign", "sendTransaction", "submit"]) expect(engine[m]).toBeUndefined();
  });
});

describe("durable conflict severity independent of quarantine retention", () => {
  const conflictingChain = () => linked([
    { height: "1", outcomes: [outcome("r1", [created(1, "alice.testnet")])] },
    { height: "2", outcomes: [
      outcome("r1", [created(1, "mallory.testnet")]),
      outcome("unknowns", [emitLog("unknown_a", {}), emitLog("unknown_b", {})]),
    ] },
  ]);

  it("keeps reconciliation after allowlisted diagnostics evict a conflict and after restart", async () => {
    const source = new RecordedBlockSource(chainFile(conflictingChain(), { finalizedHeight: "1" }));
    const first = new IndexerEngine(source, store(), config(), { maxDiagnostics: 1 });
    await first.open();
    expect((await first.sync()).status).toBe("reconciliation_required");
    source.replace(chainFile([...conflictingChain(), block({ height: "3", hash: "blk3", parentHash: "blk2", outcomes: [] })], { finalizedHeight: "3" }));
    expect((await first.sync()).status).toBe("reconciliation_required");
    expect(first.health().processedHead?.height).toBe("2");
    expect(first.health().finalizedHead).toBeNull();
    await first.close();
    const state = await store().read();
    expect(state!.diagnostics.some((d) => d.reason === "conflict_payload")).toBe(false);
    expect(state!.conflictBlocks).toEqual(["blk2"]);
    const second = await engineOn(source);
    expect((await second.engine.sync()).status).toBe("reconciliation_required");
    await second.engine.close();
  });

  it("clears only the conflict and overflow markers belonging to an orphaned provisional block", async () => {
    const source = new RecordedBlockSource(chainFile(conflictingChain(), { finalizedHeight: "1" }));
    const engine = new IndexerEngine(source, store(), config(), { maxDiagnostics: 1 });
    await engine.open();
    await engine.sync();
    source.replace(chainFile(linked([
      { height: "1", outcomes: [outcome("r1", [created(1, "alice.testnet")])] },
      { height: "2", hash: "replacement2", outcomes: [outcome("r2", [deposit(1, 0, "bob.testnet", "2")])] },
    ]), { finalizedHeight: "1" }));
    expect((await engine.sync()).status).toBe("healthy");
    await engine.close();
    const state = await store().read();
    expect(state!.conflictBlocks).toEqual([]);
    expect(state!.diagnosticOverflowBlocks).toEqual([]);
  });
});
