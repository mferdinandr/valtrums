// Fixture contract event payloads, never live score or deployment evidence.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBlock } from "../../src/indexer/parser.js";
import { buildProjection } from "../../src/indexer/projection.js";
import { IndexerEngine } from "../../src/indexer/engine.js";
import { RecordedBlockSource } from "../../src/indexer/recorded-source.js";
import { JsonFileIndexerStore } from "../../src/indexer/store.js";
import { block, config, emitLog, linked, outcome, chainFile } from "./fixtures.js";

const opened = { battle_id: "9007199254740993", round_id: "1", protocol: "lifecycle-v2", candidates: [0, 1], start_ns: "1000000000000000000",
  end_ns: "1000000030000000000", policy_hash: "frozen" };
const resolved = { ...opened, outcome: { Winner: { community: 0 } }, scores: [
  { community: 0, numerator: "-5", denominator: "100", evidence_hash: "first" },
  { community: 1, numerator: "-10", denominator: "100", evidence_hash: "second" },
] };

describe("reviewed lifecycle round event reducers", () => {
  it("parses exact signed scores and source identity; unknown/malformed evidence degrades", () => {
    const parsed = parseBlock(block({ height: "1", outcomes: [outcome("r1", [emitLog("lifecycle_round_resolved_v1", resolved)])] }), config());
    expect(parsed.diagnostics).toHaveLength(0);
    expect(parsed.accepted[0]).toMatchObject({ battleId: "9007199254740993", round: { scores: [{ numerator: "-5" }, { numerator: "-10" }] } });
    const projection = buildProjection(parsed.accepted, { finalizedHeight: 1n, reducerVersion: "projection-v1" });
    expect(projection.battles["near-testnet|arena.testnet|9007199254740993"]!.rounds!["1"]!.complete).toBe(true);
    const malformed = { ...resolved, end_ns: opened.start_ns };
    const bad = parseBlock(block({ height: "1", outcomes: [outcome("r2", [emitLog("lifecycle_round_resolved_v1", malformed), emitLog("future_round", {})])] }), config());
    expect(bad.accepted).toHaveLength(0);
    expect(bad.diagnostics.map((d) => d.reason)).toEqual(["malformed_payload", "unknown_event"]);
    const overflowing = { ...resolved, scores: resolved.scores.map((s) => ({ ...s, denominator: (2n ** 256n).toString() })) };
    expect(parseBlock(block({ height: "1", outcomes: [outcome("overflow", [emitLog("lifecycle_round_resolved_v1", overflowing)])] }), config()).accepted).toHaveLength(0);
  });
  it("replays new event evidence after restart and retracts it on provisional forks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "round-history-"));
    const blocks = linked([
      { height: "1", outcomes: [outcome("r1", [emitLog("lifecycle_round_opened_v1", opened)])] },
      { height: "2", outcomes: [outcome("r2", [emitLog("lifecycle_round_resolved_v1", resolved)])] },
    ]);
    const source = new RecordedBlockSource(chainFile(blocks, { finalizedHeight: "1" }));
    let engine = new IndexerEngine(source, new JsonFileIndexerStore(dir), config());
    try {
      await engine.open(); await engine.sync(); const digest = engine.projection().digest; await engine.close();
      engine = new IndexerEngine(source, new JsonFileIndexerStore(dir), config());
      await engine.open(); expect(engine.projection().digest).toBe(digest);
      source.replace(chainFile(linked([{ height: "1", outcomes: blocks[0]!.outcomes }, { height: "2", hash: "fork", outcomes: [] }]), { finalizedHeight: "1" }));
      await engine.sync();
      const round = engine.projection().battles["near-testnet|arena.testnet|9007199254740993"]!.rounds!["1"]!;
      expect(round.complete).toBe(false); expect(round.evidence.scores).toBeNull();
      expect(engine.confirmations().confirmable).toBe(false);
    } finally { await engine.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
