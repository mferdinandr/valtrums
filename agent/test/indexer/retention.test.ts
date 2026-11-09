// FIXTURE-ONLY: recorded sources with declared (not verified) finality and a real temp state directory.
// No live RPC and no write transport. Retention depth values here are test values, not the default.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexerEngine } from "../../src/indexer/engine.js";
import { RecordedBlockSource } from "../../src/indexer/recorded-source.js";
import { DEFAULT_FINALIZED_RETENTION_DEPTH } from "../../src/indexer/retention.js";
import { buildProjection } from "../../src/indexer/projection.js";
import { JsonFileIndexerStore, StoreCorruptError } from "../../src/indexer/store.js";
import { chainFile, config, created, deposit, emitLog, linked, outcome } from "./fixtures.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "indexer-retention-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const key = `${config().network}|${config().contracts[0]}|1`;
const open = async (source: RecordedBlockSource, depth = 3) => {
  const engine = new IndexerEngine(source, new JsonFileIndexerStore(dir), config(), { now: () => 1, finalizedRetentionDepth: depth });
  await engine.open();
  return engine;
};
const readState = () => new JsonFileIndexerStore(dir).read();

/** Heights 1..n: created at 1, then one deposit of `h` units per height (receipt `r<h>`). */
const specs = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const h = i + 1;
    return { height: String(h), outcomes: [outcome(`r${h}`, [h === 1 ? created(1) : deposit(1, 0, "bob.testnet", String(h))])] };
  });
const sum = (n: number) => (Array.from({ length: n - 1 }, (_, i) => i + 2).reduce((a, b) => a + b, 0)).toString();

describe("retention by checkpoint and prune", () => {
  it("documents a default depth and rejects an invalid one", () => {
    expect(DEFAULT_FINALIZED_RETENTION_DEPTH).toBe(10_000);
    const mk = (finalizedRetentionDepth: number) =>
      new IndexerEngine(new RecordedBlockSource(chainFile([])), new JsonFileIndexerStore(dir), config(), { finalizedRetentionDepth });
    expect(() => mk(0)).toThrow(/finalizedRetentionDepth/);
    expect(() => mk(1.5)).toThrow(/finalizedRetentionDepth/);
    expect(() => mk(500_000)).toThrow(/finalizedRetentionDepth/);
  });

  it("prunes only finalized blocks past the depth, keeps provisional blocks and every dedup record", async () => {
    // 12 blocks, finalized at 10, depth 3: blocks 1-7 are summarized; 8-10 (finalized) and 11-12 (provisional) stay.
    const source = new RecordedBlockSource(chainFile(linked(specs(12)), { finalizedHeight: "10" }));
    const engine = await open(source);
    expect((await engine.sync()).status).toBe("healthy");
    await engine.close();
    const state = (await readState())!;
    expect(state.blocks.map((b) => b.height)).toEqual(["8", "9", "10", "11", "12"]);
    expect(state.blocks.filter((b) => !b.finalized).map((b) => b.height)).toEqual(["11", "12"]);
    expect(state.checkpoint).toMatchObject({ kind: "summary", height: "7", hash: "blk7", prunedBlocks: 7, prunedEvents: 7 });
    expect(state.checkpoint?.note).toMatch(/summary/i);
    expect(state.checkpoint?.note).toMatch(/not raw history/i);
    expect(state.checkpoint?.digest).toMatch(/^[0-9a-f]{64}$/);
    // Dedup keys and events of pruned blocks are still in the journal.
    expect(state.journal).toHaveLength(12);
    expect(state.journal.filter((e) => BigInt(e.provenance.blockHeight) <= 7n)).toHaveLength(7);
  });

  it("produces the same projection as an unpruned indexer over the same chain", async () => {
    const mk = async (depth: number, sub: string) => {
      const d = await mkdtemp(join(tmpdir(), `indexer-retention-${sub}-`));
      const engine = new IndexerEngine(new RecordedBlockSource(chainFile(linked(specs(12)), { finalizedHeight: "10" })), new JsonFileIndexerStore(d), config(), { now: () => 1, finalizedRetentionDepth: depth });
      await engine.open();
      await engine.sync();
      const digest = engine.projection().digest;
      const credited = engine.projection().battles[key]!.creditedByCommunity["0"];
      await engine.close();
      await rm(d, { recursive: true, force: true });
      return { digest, credited };
    };
    const pruned = await mk(3, "a");
    const full = await mk(100, "b");
    expect(pruned).toEqual(full);
    expect(pruned.credited).toBe(sum(12));
  });
});

describe("restart after pruning", () => {
  it("restores cursors and health, verifies from the checkpoint and continues without double counting", async () => {
    const source = new RecordedBlockSource(chainFile(linked(specs(12)), { finalizedHeight: "10" }));
    let engine = await open(source);
    await engine.sync();
    const digest = engine.projection().digest;
    await engine.close();

    engine = await open(source);
    expect(engine.health()).toMatchObject({ status: "healthy", finalizedHead: { height: "10", hash: "blk10" }, processedHead: { height: "12", hash: "blk12" } });
    await engine.sync();
    await engine.sync();
    expect(engine.projection().digest).toBe(digest);
    await engine.close();
    const state = (await readState())!;
    expect(state.journal).toHaveLength(12);
    expect(state.checkpoint?.height).toBe("7");

    // New blocks link to the retained tip (not the pruned range) and a second prune chains the checkpoint.
    const longer = linked(specs(16));
    source.replace(chainFile(longer, { finalizedHeight: "14" }));
    engine = await open(source);
    expect((await engine.sync()).status).toBe("healthy");
    await engine.close();
    const next = (await readState())!;
    expect(next.checkpoint).toMatchObject({ height: "11", prunedBlocks: 11, prunedEvents: 11 });
    expect(next.checkpoint?.digest).not.toBe(state.checkpoint?.digest);
    expect(next.blocks.map((b) => b.height)).toEqual(["12", "13", "14", "15", "16"]);
    expect(next.journal).toHaveLength(16);
  });

  it("requires reconciliation when the source disagrees with the checkpoint block", async () => {
    const source = new RecordedBlockSource(chainFile(linked(specs(12)), { finalizedHeight: "10" }));
    let engine = await open(source);
    await engine.sync();
    await engine.close();

    // Same heights, but block 7 (the checkpoint block) now has a different hash on the source.
    const altered = linked(specs(12), null).map((b) => (b.header.height === "7" ? { ...b, header: { ...b.header, hash: "forged7" } } : b));
    source.replace(chainFile(altered, { finalizedHeight: "10" }));
    engine = await open(source);
    const health = await engine.sync();
    expect(health.status).toBe("reconciliation_required");
    expect(health.reason).toMatch(/checkpoint/);
    await engine.close();
    // Persisted: a further restart does not turn healthy.
    engine = await open(source);
    expect(engine.health().status).toBe("reconciliation_required");
    await engine.close();
  });

  it("fails closed when a dedup record of a pruned block was removed from the journal", async () => {
    const source = new RecordedBlockSource(chainFile(linked(specs(12)), { finalizedHeight: "10" }));
    const engine = await open(source);
    await engine.sync();
    await engine.close();
    const path = join(dir, "state.json");
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.journal = raw.journal.filter((e: { provenance: { blockHeight: string } }) => e.provenance.blockHeight !== "3");
    await writeFile(path, JSON.stringify(raw));
    await expect(new JsonFileIndexerStore(dir).open(config())).rejects.toBeInstanceOf(StoreCorruptError);
  });

  it("fails closed when the first retained block no longer links to the checkpoint", async () => {
    const source = new RecordedBlockSource(chainFile(linked(specs(12)), { finalizedHeight: "10" }));
    const engine = await open(source);
    await engine.sync();
    await engine.close();
    const path = join(dir, "state.json");
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.checkpoint.hash = "someotherhash";
    await writeFile(path, JSON.stringify(raw));
    await expect(new JsonFileIndexerStore(dir).open(config())).rejects.toBeInstanceOf(StoreCorruptError);
  });
});

describe("replay after pruning", () => {
  it("rebuilds the identical projection from the journal alone", async () => {
    const source = new RecordedBlockSource(chainFile(linked(specs(12)), { finalizedHeight: "10" }));
    const engine = await open(source);
    await engine.sync();
    const live = engine.projection();
    await engine.close();
    const state = (await readState())!;
    const replayed = buildProjection(state.journal, { finalizedHeight: 10n, reducerVersion: state.config.reducerVersion });
    expect(replayed.digest).toBe(live.digest);
    expect(replayed.battles[key]!.creditedByCommunity["0"]).toBe(sum(12));
  });

  it("does not credit a pruned receipt twice when it is delivered again in a later block", async () => {
    // Receipt r3 (deposit of 3, pruned into the checkpoint) is delivered again in block 13.
    const base = specs(12);
    const redelivered = [...base, { height: "13", outcomes: [outcome("r3", [deposit(1, 0, "bob.testnet", "3")])] }];
    const source = new RecordedBlockSource(chainFile(linked(redelivered), { finalizedHeight: "12" }));
    const engine = await open(source);
    expect((await engine.sync()).status).toBe("healthy");
    expect(engine.projection().battles[key]!.creditedByCommunity["0"]).toBe(sum(12));
    expect(engine.projection().battles[key]!.deposits).toHaveLength(11);
    await engine.close();
    const state = (await readState())!;
    expect(state.checkpoint).not.toBeNull();
    expect(state.blocks.some((b) => b.height === "3")).toBe(false); // block 3 is pruned, its dedup key is not
    expect(state.journal.filter((e) => e.dedupKey.includes("|r3|"))).toHaveLength(1);
  });

  it("flags a pruned receipt re-delivered with a different payload as a conflict, never a second credit", async () => {
    const base = specs(12);
    const conflicting = [...base, { height: "13", outcomes: [outcome("r3", [deposit(1, 0, "bob.testnet", "999")])] }];
    const source = new RecordedBlockSource(chainFile(linked(conflicting), { finalizedHeight: "12" }));
    const engine = await open(source);
    const health = await engine.sync();
    expect(health.status).toBe("reconciliation_required");
    expect(engine.projection().battles[key]!.creditedByCommunity["0"]).toBe(sum(12));
    expect(engine.confirmations().confirmable).toBe(false);
    await engine.close();
  });
});

describe("what pruning must preserve", () => {
  it("never prunes at or past a block that holds integrity evidence", async () => {
    // Block 3 carries an allowlisted-emitter log the indexer cannot read (a degrading diagnostic).
    const all = specs(12);
    all[2] = { height: "3", outcomes: [outcome("r3", [emitLog("lifecycle_deposit", { battle_id: 1 })])] };
    const source = new RecordedBlockSource(chainFile(linked(all), { finalizedHeight: "10" }));
    const engine = await open(source);
    const health = await engine.sync();
    expect(health.status).toBe("degraded");
    await engine.close();
    const state = (await readState())!;
    expect(state.checkpoint).toMatchObject({ height: "2", prunedBlocks: 2 });
    expect(state.blocks.map((b) => b.height)).toContain("3");
    expect(state.diagnostics).toHaveLength(1);
  });

  it("never prunes provisional blocks even when they exceed the depth", async () => {
    const source = new RecordedBlockSource(chainFile(linked(specs(12)), { finalizedHeight: "2" }));
    const engine = await open(source, 1);
    await engine.sync();
    await engine.close();
    const state = (await readState())!;
    expect(state.blocks.filter((b) => !b.finalized)).toHaveLength(10);
    expect(state.blocks.map((b) => b.height)).toEqual(["2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
    expect(state.checkpoint).toMatchObject({ height: "1", prunedBlocks: 1 });
  });

  it("retracts a provisional fork after earlier history was pruned", async () => {
    const source = new RecordedBlockSource(chainFile(linked(specs(12)), { finalizedHeight: "10" }));
    const engine = await open(source);
    await engine.sync();
    const forked = specs(12);
    forked[10] = { height: "11", outcomes: [outcome("r11b", [deposit(1, 0, "bob.testnet", "1")])] };
    forked[11] = { height: "12", outcomes: [outcome("r12b", [deposit(1, 0, "bob.testnet", "1")])] };
    const alt = linked(forked).map((b) => (BigInt(b.header.height) >= 11n ? { ...b, header: { ...b.header, hash: `alt${b.header.height}` } } : b));
    // Re-link the parent of block 12 to the replaced block 11.
    alt[11] = { ...alt[11]!, header: { ...alt[11]!.header, parentHash: "alt11" } };
    source.replace(chainFile(alt, { finalizedHeight: "10" }));
    const health = await engine.sync();
    expect(health.status).toBe("pending");
    expect(engine.projection().battles[key]!.creditedByCommunity["0"]).toBe((BigInt(sum(10)) + 2n).toString());
    await engine.close();
  });
});
