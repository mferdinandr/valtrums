// FIXTURE-ONLY: payload shape copied from contracts/arena/src/rounds_api.rs `round_finalized`; no live chain.
import { describe, expect, it } from "vitest";
import { parseBlock } from "../../src/indexer/parser.js";
import { buildProjection } from "../../src/indexer/projection.js";
import { roundCommitmentHex } from "../../src/indexer/round-commitment.js";
import { block, config, emitLog, outcome } from "./fixtures.js";

// Same detail and digest as contracts/arena `the_commitment_matches_the_cross_language_vector`.
const VECTOR = "4f93bb7b193a54cb56f5ab4301ddf3e76bd12593c8f4026d4c92a1e40779a1fc";
const scores = [
  { community: "0", evidenceHash: "h0", negative: false, numerator: "10", denominator: "100" },
  { community: "2", evidenceHash: "h2", negative: true, numerator: "5", denominator: "100" },
];
const detail = { battleId: "1", roundId: "2", startNs: "1000", endNs: "2000", policyHash: "pol", scores };

const payload = (over: Record<string, unknown> = {}) => ({
  schema: "round-finalized-v1",
  battle_id: "1",
  round_id: "2",
  outcome: "winner",
  winner: 0,
  next_candidates: [],
  start_ns: "1000",
  end_ns: "2000",
  policy_hash: "pol",
  commitment: VECTOR,
  scores: scores.map((s) => ({ community: Number(s.community), evidence_hash: s.evidenceHash, negative: s.negative, numerator: s.numerator, denominator: s.denominator })),
  ...over,
});
const parse = (data: Record<string, unknown>) =>
  parseBlock(block({ height: "7", outcomes: [outcome("r1", [emitLog("round_finalized", data)])] }), config());

describe("round_finalized", () => {
  it("recomputes the arena's commitment (cross-language vector)", () => {
    expect(roundCommitmentHex(detail)).toBe(VECTOR);
    expect(roundCommitmentHex({ ...detail, endNs: "2001" })).not.toBe(VECTOR);
    expect(roundCommitmentHex({ ...detail, scores: [{ ...scores[0]!, numerator: "11" }, scores[1]!] })).not.toBe(VECTOR);
    expect(roundCommitmentHex({ ...detail, scores: [{ ...scores[0]!, evidenceHash: "hX" }, scores[1]!] })).not.toBe(VECTOR);
  });

  it("is accepted with exact detail and no diagnostics", () => {
    const { accepted, diagnostics } = parse(payload());
    expect(diagnostics).toEqual([]);
    expect(accepted[0]).toMatchObject({ name: "round_finalized", battleId: "1", roundId: "2", outcome: "winner", winner: "0", commitment: VECTOR });
  });

  it("keeps u64 values beyond the JS safe integer range exact", () => {
    const big = "18446744073709551615";
    const d = { ...detail, battleId: big, roundId: big, startNs: big, endNs: big };
    const { accepted, diagnostics } = parse(payload({ battle_id: big, round_id: big, start_ns: big, end_ns: big, commitment: roundCommitmentHex(d) }));
    expect(diagnostics).toEqual([]);
    expect(accepted[0]).toMatchObject({ battleId: big, roundId: big, startNs: big, endNs: big });
  });

  it.each([
    ["a changed score", { scores: [{ community: 0, evidence_hash: "h0", negative: false, numerator: "11", denominator: "100" }, { community: 2, evidence_hash: "h2", negative: true, numerator: "5", denominator: "100" }] }],
    ["a changed window", { end_ns: "2001" }],
    ["another commitment", { commitment: "00".repeat(32) }],
    ["an unsupported schema", { schema: "round-finalized-v2" }],
    ["a pending outcome", { outcome: "pending" }],
    ["a winner outcome without a winner", { winner: null }],
    ["an overtime outcome with a winner", { outcome: "overtime", next_candidates: [0, 2] }],
    ["no scores", { scores: [] }],
  ])("quarantines %s instead of accepting it", (_n, over) => {
    const { accepted, diagnostics } = parse(payload(over));
    expect(accepted).toEqual([]);
    expect(diagnostics[0]?.reason).toBe("malformed_payload");
  });

  it("projects rounds per battle, only when events exist, and replays identically", () => {
    const { accepted } = parse(payload());
    const proj = buildProjection(accepted, { finalizedHeight: 7n, reducerVersion: "projection-v1" });
    const battle = Object.values(proj.battles)[0]!;
    expect(battle.rounds).toHaveLength(1);
    expect(battle.rounds?.[0]).toMatchObject({ roundId: "2", outcome: "winner", winner: "0", commitment: VECTOR, ref: { finalized: true } });
    expect(buildProjection([...accepted, ...accepted], { finalizedHeight: 7n, reducerVersion: "projection-v1" }).digest).toBe(proj.digest);
    // A battle with no round_finalized has no `rounds` key, so older journals project exactly as before.
    const created = parseBlock(block({ height: "7", outcomes: [outcome("r1", [emitLog("lifecycle_battle_created", { battle_id: 1, creator: "a.testnet" })])] }), config());
    const plain = Object.values(buildProjection(created.accepted, { finalizedHeight: 7n, reducerVersion: "projection-v1" }).battles)[0]!;
    expect("rounds" in plain).toBe(false);
  });
});
