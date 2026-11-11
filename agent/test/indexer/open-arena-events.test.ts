// FIXTURE-ONLY: payload shapes follow the arena emitters (contracts/arena/src/open_arena.rs); no live chain.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexerEngine } from "../../src/indexer/engine.js";
import { parseBlock } from "../../src/indexer/parser.js";
import { buildProjection } from "../../src/indexer/projection.js";
import { RecordedBlockSource } from "../../src/indexer/recorded-source.js";
import { JsonFileIndexerStore } from "../../src/indexer/store.js";
import { block, chainFile, config, created, deposit, emitLog, emitRaw, linked, outcome } from "./fixtures.js";

const added = (battleId: number, community: number, representation: string, accountId: string) =>
  emitLog("lifecycle_community_added", { battle_id: battleId, community, representation, account_id: accountId });
const cancelled = (battleId: number) => emitLog("lifecycle_battle_cancelled", { battle_id: battleId });
const refund = (battleId: number, community: number, accountId: string, amount: string) =>
  emitLog("lifecycle_refund", { battle_id: battleId, community, account_id: accountId, amount });
const refundFailed = (battleId: number, community: number, accountId: string, amount: string) =>
  emitLog("lifecycle_refund_failed", { battle_id: battleId, community, account_id: accountId, amount });
const joinableSet = (representation: string) => emitLog("lifecycle_joinable_asset_set", { representation });
const joinableRemoved = (representation: string) => emitLog("lifecycle_joinable_asset_removed", { representation });

const parse = (...logs: string[]) =>
  parseBlock(block({ height: "7", outcomes: logs.map((l, i) => outcome(`r${i}`, [l])) }), config());

describe("open arena events: parsing", () => {
  it("accepts the three events with exact integers", () => {
    const { accepted, diagnostics } = parse(
      added(4, 2, "cashcat.rep.testnet", "bob.testnet"),
      cancelled(4),
      refund(4, 2, "bob.testnet", "340282366920938463463374607431768211455"),
    );
    expect(diagnostics).toEqual([]);
    expect(accepted.map((e) => e.name)).toEqual(["lifecycle_community_added", "lifecycle_battle_cancelled", "lifecycle_refund"]);
    expect(accepted[0]).toMatchObject({ battleId: "4", community: "2", representation: "cashcat.rep.testnet", accountId: "bob.testnet" });
    expect(accepted[1]).toMatchObject({ battleId: "4" });
    expect(accepted[2]).toMatchObject({ amount: "340282366920938463463374607431768211455" });
  });
  it("keeps a u64 battle id beyond 2^53 exact", () => {
    const { accepted } = parse(emitRaw("lifecycle_battle_cancelled", '{"battle_id":12345678901234567890}'));
    expect(accepted[0]).toMatchObject({ name: "lifecycle_battle_cancelled", battleId: "12345678901234567890" });
  });
  it("quarantines malformed or unsafe payloads instead of applying them", () => {
    const bad = [
      emitLog("lifecycle_community_added", { battle_id: 1, community: 0, account_id: "bob.testnet" }),
      emitLog("lifecycle_community_added", { battle_id: 1, community: -1, representation: "r.testnet", account_id: "bob.testnet" }),
      emitLog("lifecycle_battle_cancelled", {}),
      emitLog("lifecycle_refund", { battle_id: 1, community: 0, account_id: "bob.testnet", amount: "-5" }),
      emitRaw("lifecycle_refund", '{"battle_id":1,"community":0,"account_id":"bob.testnet","amount":1.5}'),
    ];
    for (const log of bad) {
      const { accepted, diagnostics } = parse(log);
      expect(accepted).toEqual([]);
      expect(diagnostics).toHaveLength(1);
    }
  });
  it("does not accept the events from a foreign emitter or a failed receipt", () => {
    const foreign = parseBlock(block({ height: "7", outcomes: [outcome("r1", [cancelled(1)], { executorId: "evil.testnet" })] }), config());
    expect(foreign.accepted).toEqual([]);
    expect(foreign.diagnostics.map((d) => d.reason)).toEqual(["wrong_emitter"]);
    const failed = parseBlock(block({ height: "7", outcomes: [outcome("r1", [cancelled(1)], { success: false })] }), config());
    expect(failed.accepted).toEqual([]);
    expect(failed.diagnostics.map((d) => d.reason)).toEqual(["failed_outcome"]);
  });
});

describe("open arena events: projection", () => {
  const project = (...logs: string[]) => {
    const { accepted } = parse(...logs);
    return Object.values(buildProjection(accepted, { finalizedHeight: 7n, reducerVersion: "projection-v1" }).battles);
  };
  it("projects appended communities, the cancellation and refunds with exact sums", () => {
    const [b] = project(
      created(4, "alice.testnet"),
      added(4, 2, "wallet.rep.testnet", "bob.testnet"),
      added(4, 3, "good.rep.testnet", "carol.testnet"),
      deposit(4, 2, "bob.testnet", "100"),
      cancelled(4),
      refund(4, 2, "bob.testnet", "60"),
      refund(4, 2, "bob.testnet", "40"),
    );
    expect(b!.communitiesAdded!.map((c) => [c.community, c.representation])).toEqual([["2", "wallet.rep.testnet"], ["3", "good.rep.testnet"]]);
    expect(b!.cancelled).toMatchObject({ finalized: true });
    expect(b!.refunds!.map((r) => r.amount)).toEqual(["60", "40"]);
    expect(b!.refundedByCommunity).toEqual({ "2": "100" });
    expect(b!.creditedByCommunity).toEqual({ "2": "100" });
    expect(b!.activity).toHaveLength(7);
  });
  it("records a failed refund apart from paid refunds and tracks the joinable allowlist per arena", () => {
    const { accepted, diagnostics } = parse(
      created(4, "alice.testnet"),
      deposit(4, 2, "bob.testnet", "100"),
      cancelled(4),
      refundFailed(4, 2, "bob.testnet", "100"),
      joinableSet("cashcat.rep.testnet"),
      joinableSet("ai.rep.testnet"),
      joinableRemoved("ai.rep.testnet"),
    );
    expect(diagnostics).toEqual([]);
    const projection = buildProjection(accepted, { finalizedHeight: 7n, reducerVersion: "projection-v1" });
    const b = Object.values(projection.battles)[0]!;
    expect(b.refundFailures!.map((r) => [r.community, r.accountId, r.amount])).toEqual([["2", "bob.testnet", "100"]]);
    expect(b).not.toHaveProperty("refunds");
    expect(b).not.toHaveProperty("refundedByCommunity");
    const arena = Object.values(projection.contracts)[0]!;
    expect(arena.joinableRepresentations).toEqual({ "cashcat.rep.testnet": true, "ai.rep.testnet": false });
    expect(arena.trustedRepresentations).toEqual({}); // joinable never implies trusted
  });
  it("records an abandoned round window and quarantines a malformed one", () => {
    const reopened = emitLog("lifecycle_round_reopened_v1", { battle_id: 2, round_id: "1", protocol: "lifecycle-v2", abandoned_start_ns: "1794407306000000000", abandoned_end_ns: "1794407336000000000" });
    const { accepted, diagnostics } = parse(created(2, "alice.testnet"), reopened);
    expect(diagnostics).toEqual([]);
    const b = Object.values(buildProjection(accepted, { finalizedHeight: 7n, reducerVersion: "projection-v1" }).battles)[0]!;
    expect(b.roundReopens).toEqual([expect.objectContaining({ roundId: "1", abandonedStartNs: "1794407306000000000", abandonedEndNs: "1794407336000000000" })]);
    const bad = parse(emitLog("lifecycle_round_reopened_v1", { battle_id: 2, round_id: "1" }));
    expect(bad.accepted).toEqual([]);
    expect(bad.diagnostics).toHaveLength(1);
  });
  it("quarantines malformed allowlist and failed-refund payloads", () => {
    for (const log of [
      emitLog("lifecycle_joinable_asset_set", {}),
      emitLog("lifecycle_joinable_asset_removed", { representation: 5 }),
      emitLog("lifecycle_refund_failed", { battle_id: 1, community: 0, account_id: "bob.testnet", amount: "-1" }),
    ]) {
      const { accepted, diagnostics } = parse(log);
      expect(accepted).toEqual([]);
      expect(diagnostics).toHaveLength(1);
    }
  });
  it("leaves battles without these events unchanged and is deterministic across order and duplicates", () => {
    const [plain] = project(created(1, "alice.testnet"));
    expect(plain).not.toHaveProperty("communitiesAdded");
    expect(plain).not.toHaveProperty("cancelled");
    expect(plain).not.toHaveProperty("refunds");
    const { accepted } = parse(created(4, "a.testnet"), added(4, 2, "wallet.rep.testnet", "bob.testnet"), cancelled(4), refund(4, 2, "bob.testnet", "5"));
    const opts = { finalizedHeight: 7n, reducerVersion: "projection-v1" };
    const forward = buildProjection(accepted, opts);
    const shuffled = buildProjection([...accepted].reverse().concat(accepted[0]!), opts);
    expect(shuffled.digest).toBe(forward.digest);
  });
});

describe("open arena events: store and health", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "indexer-open-arena-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const run = async (logs: string[]) => {
    const chain = linked([{ height: "1", outcomes: logs.map((l, i) => outcome(`r${i}`, [l])) }]);
    const source = new RecordedBlockSource(chainFile(chain, { finalizedHeight: "1" }));
    const engine = new IndexerEngine(source, new JsonFileIndexerStore(dir, { lockStaleMs: 10_000 }), config(), { now: () => 1000 });
    await engine.open();
    const health = await engine.sync();
    const projection = engine.projection();
    await engine.close();
    return { health, projection };
  };

  it("persists the events and reloads them through the store's journal validation", async () => {
    const first = await run([created(4, "alice.testnet"), added(4, 2, "wallet.rep.testnet", "bob.testnet"), cancelled(4), refund(4, 2, "bob.testnet", "9")]);
    expect(first.health.status).toBe("healthy");
    // A restart reopens the persisted state; an invalid journal event would be refused here.
    const engine = new IndexerEngine(
      new RecordedBlockSource(chainFile(linked([{ height: "1", outcomes: [outcome("r0", [created(4, "alice.testnet")])] }]), { finalizedHeight: "1" })),
      new JsonFileIndexerStore(dir, { lockStaleMs: 10_000 }),
      config(),
      { now: () => 2000 },
    );
    await engine.open();
    const battle = Object.values(engine.projection().battles)[0]!;
    expect(battle.refunds).toHaveLength(1);
    expect(battle.cancelled).toBeDefined();
    expect(battle.communitiesAdded).toHaveLength(1);
    await engine.close();
  });
  it("stays healthy through allowlist proposals and a failed refund, and reloads them", async () => {
    const first = await run([created(4, "alice.testnet"), cancelled(4), refundFailed(4, 2, "bob.testnet", "9"), joinableSet("cashcat.rep.testnet"), joinableRemoved("cashcat.rep.testnet")]);
    expect(first.health.status).toBe("healthy");
    const engine = new IndexerEngine(
      new RecordedBlockSource(chainFile(linked([{ height: "1", outcomes: [outcome("r0", [created(4, "alice.testnet")])] }]), { finalizedHeight: "1" })),
      new JsonFileIndexerStore(dir, { lockStaleMs: 10_000 }),
      config(),
      { now: () => 2000 },
    );
    await engine.open();
    const projection = engine.projection();
    expect(Object.values(projection.battles)[0]!.refundFailures).toHaveLength(1);
    expect(Object.values(projection.contracts)[0]!.joinableRepresentations).toEqual({ "cashcat.rep.testnet": false });
    await engine.close();
  });
  it("still degrades on an unknown event from the allowlisted emitter", async () => {
    for (const event of ["mystery_event"]) {
      const d = await mkdtemp(join(tmpdir(), "indexer-open-arena-unknown-"));
      try {
        const chain = linked([{ height: "1", outcomes: [outcome("r1", [cancelled(1), emitLog(event, { battle_id: 1 })])] }]);
        const engine = new IndexerEngine(
          new RecordedBlockSource(chainFile(chain, { finalizedHeight: "1" })),
          new JsonFileIndexerStore(d, { lockStaleMs: 10_000 }),
          config(),
          { now: () => 1 },
        );
        await engine.open();
        const health = await engine.sync();
        expect(health.status).toBe("degraded");
        expect(health.quarantined).toBe(1);
        await engine.close();
      } finally {
        await rm(d, { recursive: true, force: true });
      }
    }
  });
});
