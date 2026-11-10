// FIXTURE-ONLY: recorded sources with declared (not verified) finality and a real temp state directory.
// No live RPC and no write transport: the engine under test has no authority over funds.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexerEngine } from "../../src/indexer/engine.js";
import { RecordedBlockSource } from "../../src/indexer/recorded-source.js";
import { JsonFileIndexerStore } from "../../src/indexer/store.js";
import { chainFile, config, created, deposit, linked, outcome } from "./fixtures.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "indexer-reorg-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const open = async (source: RecordedBlockSource) => {
  const engine = new IndexerEngine(source, new JsonFileIndexerStore(dir), config(), { now: () => 1 });
  await engine.open();
  return engine;
};
const key = `${config().network}|${config().contracts[0]}|1`;

const mainChain = () =>
  linked([
    { height: "1", outcomes: [outcome("r1", [created(1)])] },
    { height: "2", outcomes: [outcome("r2", [deposit(1, 0, "bob.testnet", "100")])] },
    { height: "3", outcomes: [outcome("r3", [deposit(1, 0, "bob.testnet", "200")])] },
    { height: "4", outcomes: [outcome("r4", [deposit(1, 0, "bob.testnet", "400")])] },
  ]);
const forkChain = () =>
  linked([
    { height: "1", outcomes: [outcome("r1", [created(1)])] },
    { height: "2", outcomes: [outcome("r2", [deposit(1, 0, "bob.testnet", "100")])] },
    { height: "3", hash: "blk3b", outcomes: [outcome("r3b", [deposit(1, 0, "bob.testnet", "7")])] },
    { height: "4", hash: "blk4b", outcomes: [outcome("r4b", [])] },
  ]);

describe("reorg retracts provisional projections and suspends confirmations until finality returns", () => {
  it("suspends, survives a restart, and lifts only when finality reaches the retracted range", async () => {
    const source = new RecordedBlockSource(chainFile(mainChain(), { finalizedHeight: "2" }));
    let engine = await open(source);
    expect((await engine.sync()).status).toBe("healthy");
    expect(engine.confirmations()).toMatchObject({ confirmable: true, finalizedCredits: { [key]: { "0": "100" } } });
    expect(engine.projection().battles[key]!.creditedByCommunity["0"]).toBe("700");

    // Fork replaces provisional heights 3-4; finality is still at 2.
    source.replace(chainFile(forkChain(), { finalizedHeight: "2" }));
    const health = await engine.sync();
    expect(health.status).toBe("pending");
    expect(engine.projection().battles[key]!.creditedByCommunity["0"]).toBe("107"); // 300 and 400 retracted
    const suspended = engine.confirmations();
    expect(suspended.confirmable).toBe(false);
    expect(suspended.finalizedCredits).toEqual({});
    expect(suspended.suspension).toMatchObject({ sinceHeight: "3", untilFinalizedHeight: "4", retractedBlocks: 2, retractedEvents: 2 });
    await engine.close();

    // A restart keeps the suspension and the non-healthy status; it never reports healthy.
    engine = await open(source);
    expect(engine.health().status).toBe("pending");
    expect(engine.confirmations().confirmable).toBe(false);
    // Finality advancing only partway (height 3) does not lift it.
    source.replace(chainFile(forkChain(), { finalizedHeight: "3" }));
    expect((await engine.sync()).status).toBe("pending");
    expect(engine.confirmations().confirmable).toBe(false);
    // Finality reaching the highest retracted height restores confirmations on the canonical chain.
    source.replace(chainFile(forkChain(), { finalizedHeight: "4" }));
    expect((await engine.sync()).status).toBe("healthy");
    expect(engine.confirmations()).toMatchObject({ confirmable: true, suspension: null, finalizedCredits: { [key]: { "0": "107" } } });
    await engine.close();
    const state = await new JsonFileIndexerStore(dir).read();
    expect(state?.reorgSuspension).toBeNull();
  });

  it("suspends confirmations while reconciliation is required and never releases the finalized credits", async () => {
    const source = new RecordedBlockSource(chainFile(mainChain().slice(0, 3), { finalizedHeight: "3" }));
    const engine = await open(source);
    await engine.sync();
    // The source now finalizes a different block at 3: a finalized conflict, never a rewrite.
    const conflicting = linked([
      { height: "1", outcomes: [outcome("r1", [created(1)])] },
      { height: "2", outcomes: [outcome("r2", [deposit(1, 0, "bob.testnet", "100")])] },
      { height: "3", hash: "blk3b", outcomes: [outcome("r3b", [deposit(1, 0, "bob.testnet", "9")])] },
    ]);
    source.replace(chainFile(conflicting, { finalizedHeight: "3" }));
    expect((await engine.sync()).status).toBe("reconciliation_required");
    expect(engine.confirmations()).toMatchObject({ confirmable: false, finalizedCredits: {} });
    await engine.close();
  });
});

describe("restart and replay do not double count", () => {
  it("keeps the finalized cursor after restart and re-sync adds nothing", async () => {
    const source = new RecordedBlockSource(chainFile(mainChain(), { finalizedHeight: "3" }));
    let engine = await open(source);
    await engine.sync();
    const before = engine.projection().digest;
    await engine.close();

    for (let i = 0; i < 2; i++) {
      engine = await open(source);
      expect(engine.health().finalizedHead).toEqual({ height: "3", hash: "blk3" });
      await engine.sync();
      expect(engine.projection().digest).toBe(before);
      await engine.close();
    }
    const state = await new JsonFileIndexerStore(dir).read();
    expect(state?.journal).toHaveLength(4);
  });

  it("delivering the same receipt events again in a later block changes nothing", async () => {
    // The identical receipt (same id, log and payload) shows up again in block 5; the dedup key is
    // network|contract|receipt|log|item, so the second delivery is an idempotent no-op.
    const specs = [
      { height: "1", outcomes: [outcome("r1", [created(1)])] },
      { height: "2", outcomes: [outcome("r2", [deposit(1, 0, "bob.testnet", "100")])] },
      { height: "3", outcomes: [outcome("r2", [deposit(1, 0, "bob.testnet", "100")])] },
    ];
    const engine = await open(new RecordedBlockSource(chainFile(linked(specs), { finalizedHeight: "3" })));
    expect((await engine.sync()).status).toBe("healthy");
    expect(engine.projection().battles[key]!.creditedByCommunity["0"]).toBe("100");
    expect(engine.projection().battles[key]!.deposits).toHaveLength(1);
    await engine.close();
  });

  it("the same receipt id with a different payload is a conflict, never a second credit", async () => {
    const specs = [
      { height: "1", outcomes: [outcome("r1", [created(1)])] },
      { height: "2", outcomes: [outcome("r2", [deposit(1, 0, "bob.testnet", "100")])] },
      { height: "3", outcomes: [outcome("r2", [deposit(1, 0, "bob.testnet", "999")])] },
    ];
    const engine = await open(new RecordedBlockSource(chainFile(linked(specs), { finalizedHeight: "3" })));
    expect((await engine.sync()).status).toBe("reconciliation_required");
    expect(engine.confirmations().confirmable).toBe(false);
    await engine.close();
  });
});
