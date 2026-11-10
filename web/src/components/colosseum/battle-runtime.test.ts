import { describe, expect, it } from "vitest";
import type { BattleView, TokenMeta } from "@/lib/arena/types";
import { battleRoster, recordedRuntime } from "./battle-runtime";
import { roundAt, beatAt } from "./choreography";

const START = 1_800_000_000_000;
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const battle: BattleView = {
  id: 1,
  creator: "creator.testnet",
  token_a: "cashcat.demo",
  token_b: "unmapped.testnet",
  bond: "0",
  duration_ns: ns(300_000),
  deposit_deadline_ns: ns(START),
  status: "Live",
  vault_a: "100",
  vault_b: "100",
  start_time_ns: ns(START),
  end_time_ns: ns(START + 300_000),
  initial_price_a: "100",
  initial_price_b: "100",
  final_price_a: null,
  final_price_b: null,
  winner: null,
};
const tokens: TokenMeta[] = [
  { id: battle.token_a, symbol: "CASHCAT", decimals: 18 },
  { id: battle.token_b, symbol: "CASHCAT", decimals: 18 },
];
const roster = battleRoster(tokens);

describe("integrated recorded battle arena", () => {
  it("matches characters by token contract, never by a shared ticker", () => {
    expect(roster[0]!.asset).toBe("cashcat");
    expect(roster[1]).toMatchObject({
      asset: "generic",
      generic: true,
      name: "CASHCAT",
      referenceAddress: "",
      referenceChainId: 0,
    });
    expect(
      battleRoster(
        Array.from({ length: 8 }, (_, i) => ({
          id: `token${i}.testnet`,
          symbol: `T${i}`,
          decimals: 18,
        })),
      ),
    ).toHaveLength(8);
  });
  it("uses the recorded duration rather than the exhibition's 30-second cycle", () => {
    const state = recordedRuntime(battle, roster, START + 120_000);
    expect(state.phase).toBe("battle");
    expect(roundAt(state)).toMatchObject({
      round: 1,
      stage: "fighting",
      elapsed: 120,
      remaining: 180,
      winner: null,
      history: [],
    });
    expect(roundAt({ ...state, time: 10000, scenario: "clean" })).toEqual(
      roundAt(state),
    );
  });
  it("holds after clock expiry without inventing a winner, elimination or overtime", () => {
    for (const status of ["Live", "Settling"] as const) {
      const state = recordedRuntime(
        { ...battle, status },
        roster,
        START + 900_000,
      );
      expect(roundAt(state)).toMatchObject({
        round: 1,
        stage: "pending",
        winner: null,
        eliminated: [],
        history: [],
        scores: [],
      });
      expect(beatAt(state).fighting).toBe(false);
    }
  });
  it("celebrates only the recorded settled winner and never halted/voided/settling states", () => {
    for (const status of ["EmergencyHalted", "Voided", "Settling"] as const) {
      expect(
        recordedRuntime(
          { ...battle, status, winner: "A" },
          roster,
          START + 400_000,
        ).phase,
      ).not.toBe("result");
    }
    const state = recordedRuntime(
      { ...battle, status: "Settled", winner: "B" },
      roster,
      START + 400_000,
    );
    expect(state.phase).toBe("result");
    expect(roundAt(state)).toMatchObject({
      winner: 1,
      eliminated: [0],
      history: [],
    });
  });
  it("keeps the view-only multi-community fixture from inheriting a legacy A/B winner", () => {
    const state = recordedRuntime(
      {
        ...battle,
        status: "Settled",
        winner: "A",
        demo_communities: tokens.map((t) => ({ token: t.id, vault: "100" })),
      },
      roster,
      START + 400_000,
    );
    expect(roundAt(state).winner).toBeNull();
    expect(state.phase).not.toBe("result");
  });
  it("keeps cosmetic pause and camera selection independent of recorded state", () => {
    const state = recordedRuntime(battle, roster, START + 70_000);
    expect(
      roundAt({
        ...state,
        paused: true,
        time: 0,
        selected: 1,
        camera: "follow",
      }),
    ).toEqual(roundAt(state));
    const beat = beatAt({ ...state, phase: "battle", time: 8 });
    expect(beat.target.owner).toBe(beat.attacker);
  });
});
