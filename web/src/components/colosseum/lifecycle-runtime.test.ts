import { describe, expect, it } from "vitest";
import type { LifecycleDetail } from "@/lib/arena-read/lifecycle";
import { lifecycleRoster, lifecycleRuntime } from "./lifecycle-runtime";
import { CONTENDERS, beatAt, fighterPose, roundAt } from "./choreography";

const START = 1_800_000_000_000;
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const detail = (): LifecycleDetail => ({
  battleId: "18446744073709551615",
  battle: {
    creator: "creator.testnet",
    protocol: "protocol.testnet",
    protocol_created: false,
    fee_bps: 10,
    creator_share_bps: 5000,
    mode: "PriceGain",
    locked: true,
    observation_policy_version: "1",
    observation_policy_hash: "policy",
    principal_community: null,
    principal_amount: null,
    communities: [0, 1, 2].map((i) => ({
      chain_id: "46630",
      token_address: `0x${String(i + 1).repeat(40)}`,
      representation: `crew${i}.testnet`,
      custody_domain: "custody-v1",
      reference_chain_id: null,
      reference_address: null,
      vault: "18446744073709551615",
      audit_policy_hash: "audit",
      audit_evidence_hash: "evidence",
      audit_expires_at_ms: "9999999999999",
      backing_evidence_hash: "backing",
    })),
  },
  round: {
    round_id: "2",
    candidates: [0, 2],
    start_ns: ns(START),
    end_ns: ns(START + 30_000),
    winner: null,
  },
  readiness: null,
  history: null,
});

describe("lifecycle arena authority", () => {
  it("uses recorded candidates and interval without legacy A/B adaptation or fixture overtime", () => {
    const d = detail(),
      roster = lifecycleRoster(d.battle.communities);
    const state = lifecycleRuntime(d, roster, START + 12_000);
    expect(state.phase).toBe("battle");
    expect(roundAt(state)).toMatchObject({
      round: 2,
      stage: "fighting",
      elapsed: 12,
      remaining: 18,
      candidates: [0, 2],
      eliminated: [1],
      winner: null,
      scores: [],
      history: [],
    });
    expect(roundAt({ ...state, time: 99999, scenario: "clean" })).toEqual(
      roundAt(state),
    );
    expect(beatAt({ ...state, time: 10 }).attacker).not.toBe(1);
  });
  it("does not celebrate before a recorded winner or animate a round before its recorded start", () => {
    const d = detail(),
      roster = lifecycleRoster(d.battle.communities);
    expect(lifecycleRuntime(d, roster, START - 1000).phase).toBe("ready");
    const ended = lifecycleRuntime(d, roster, START + 900_000);
    expect(ended.phase).toBe("ready");
    expect(roundAt(ended)).toMatchObject({
      stage: "pending",
      winner: null,
      candidates: [0, 2],
      eliminated: [1],
      history: [],
    });
    expect(beatAt(ended).fighting).toBe(false);
  });
  it("celebrates only a recorded valid winner and survives unread/huge round IDs", () => {
    const d = detail(),
      roster = lifecycleRoster(d.battle.communities);
    d.round!.winner = 2;
    expect(lifecycleRuntime(d, roster, 0).phase).toBe("result");
    expect(roundAt(lifecycleRuntime(d, roster, 0))).toMatchObject({
      winner: 2,
      eliminated: [0, 1],
    });
    d.round!.winner = 99;
    d.round!.round_id = "18446744073709551615";
    expect(
      roundAt(lifecycleRuntime(d, roster, START + 90_000)).winner,
    ).toBeNull();
    d.round = null;
    expect(roundAt(lifecycleRuntime(d, roster, START))).toMatchObject({
      stage: "pending",
      scores: [],
      history: [],
      eliminated: [],
    });
  });
  it("matches cosmetic models by a full contract-bound reference identity, not a ticker or index", () => {
    const d = detail(),
      known = CONTENDERS[0]!;
    d.battle.communities[0]!.representation = "cashcat.testnet";
    expect(lifecycleRoster(d.battle.communities)[0]!.generic).toBe(true);
    d.battle.communities[0]!.reference_chain_id = String(
      known.referenceChainId,
    );
    d.battle.communities[0]!.reference_address =
      known.referenceAddress.toUpperCase();
    expect(lifecycleRoster(d.battle.communities)[0]!.asset).toBe(known.asset);
    d.battle.communities[0]!.reference_chain_id = "1";
    expect(lifecycleRoster(d.battle.communities)[0]!.generic).toBe(true);
  });
  it("maps every registry reference to its own model regardless of roster order", () => {
    const template = detail().battle.communities[0]!;
    const reversed = [...CONTENDERS].reverse();
    const communities = reversed.map((c) => ({
      ...template,
      reference_chain_id: String(c.referenceChainId),
      reference_address: c.referenceAddress.toUpperCase(),
    }));
    expect(lifecycleRoster(communities).map((c) => c.asset)).toEqual(reversed.map((c) => c.asset));
    expect(lifecycleRoster(communities).every((c) => !c.generic)).toBe(true);
  });
  it("keeps sixteen generic communities distinct and spaced around the arena", () => {
    const d = detail();
    d.battle.communities = Array.from({ length: 16 }, (_, i) => ({
      ...d.battle.communities[0]!,
      representation: `crew${i}.testnet`,
    }));
    const roster = lifecycleRoster(d.battle.communities),
      state = lifecycleRuntime(d, roster, START);
    expect(new Set(roster.map((c) => c.number)).size).toBe(16);
    const positions = roster.map((_, i) => fighterPose(i, state));
    for (let i = 0; i < positions.length; i++) {
      const a = positions[i]!,
        b = positions[(i + 1) % positions.length]!;
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(2);
    }
  });
});
