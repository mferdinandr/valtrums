// FIXTURE-ONLY: fake chain reads, a fake NEAR AI client and a fake signer. No network.
import { describe, expect, it } from "vitest";
import type { AutonomousAgentConfig, FunctionCallRequest } from "../../src/player/autonomous.js";
import { parseVoteChoice, type ModelProposer, type VoteInput } from "../../src/player/model.js";
import { claimOnce, voteOnce, type VoteDeps } from "../../src/player/rewards.js";
import { PlayerState } from "../../src/player/state.js";

const ME = "agent1.testnet";
const TOKEN = "backing-cashcat.testnet";
const NOW = 1_800_000_000_000;
const agent: AutonomousAgentConfig = {
  account: ME, style: "crowd", keyEnv: "PLAYER_KEY_AGENT1", fractionBps: 2_500, maxPerHour: 6, maxModelCallsPerHour: 12, maxFailures: 3,
  intervalSecs: 15, scanBattles: 10, minStartLeadMs: 90_000, approvalWaitMs: 30_000,
};

describe("claiming the prize", () => {
  const setup = (over: { entitlement?: bigint; registered?: boolean; live?: boolean } = {}) => {
    const calls: FunctionCallRequest[] = [];
    const logs: Record<string, unknown>[] = [];
    const deps = {
      joinable: async () => [TOKEN],
      entitlement: async () => over.entitlement ?? 5n,
      registered: async () => over.registered ?? true,
      sign: async (_a: AutonomousAgentConfig, c: FunctionCallRequest) => (calls.push(c), `hash${calls.length}`),
      log: (e: Record<string, unknown>) => logs.push(e),
      live: over.live ?? true,
    };
    return { deps, calls, logs };
  };
  it("claims the whole entitlement into the agent's own account", async () => {
    const { deps, calls, logs } = setup();
    await claimOnce(agent, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ receiverId: TOKEN, methodName: "claim_entitlement_as_representation", args: { amount: "5" }, deposit: "1" });
    expect(logs.at(-1)).toMatchObject({ event: "claimed", amount: "5", txHash: "hash1" });
  });
  it("registers on the token first when the agent is not registered", async () => {
    const { deps, calls } = setup({ registered: false });
    await claimOnce(agent, deps);
    expect(calls.map((c) => c.methodName)).toEqual(["storage_deposit", "claim_entitlement_as_representation"]);
    expect(calls[0]!.args).toEqual({ account_id: ME, registration_only: true });
  });
  it("does nothing without an entitlement, and only plans in a dry run", async () => {
    const none = setup({ entitlement: 0n });
    await claimOnce(agent, none.deps);
    expect(none.calls).toHaveLength(0);
    const dry = setup({ live: false });
    await claimOnce(agent, dry.deps);
    expect(dry.calls).toHaveLength(0);
    expect(dry.logs[0]).toMatchObject({ event: "claim_planned" });
  });
  it("logs a failed claim instead of throwing", async () => {
    const { deps, logs } = setup();
    deps.sign = async () => {
      throw new Error("Insufficient entitlement");
    };
    await expect(claimOnce(agent, deps)).resolves.toBeUndefined();
    expect(logs.at(-1)).toMatchObject({ event: "claim_error", message: "Insufficient entitlement" });
  });
});

describe("reading a vote answer", () => {
  it("accepts only a whole burn share from 0 to 100", () => {
    expect(parseVoteChoice('{"action":"vote","burnPercent":40,"rationale":"x"}')).toBe(40);
    expect(parseVoteChoice('```json\n{"action":"vote","burnPercent":0}\n```')).toBe(0);
    for (const bad of ['{"action":"vote","burnPercent":101}', '{"action":"vote","burnPercent":-1}', '{"action":"vote","burnPercent":2.5}', '{"action":"vote","burnPercent":"50"}', '{"action":"deposit","burnPercent":5}', "burn it all", "{}"]) {
      expect(parseVoteChoice(bad), bad).toBeNull();
    }
  });
});

describe("voting as a winner", () => {
  const setup = (over: { winner?: number | null; status?: "voting" | "decided"; closes?: string; amount?: string; answer?: string | null; live?: boolean } = {}) => {
    const calls: FunctionCallRequest[] = [];
    const logs: Record<string, unknown>[] = [];
    const seen: VoteInput[] = [];
    const model: ModelProposer = {
      propose: async () => null,
      proposeVote: async (input) => {
        seen.push(input);
        return over.answer === null ? null : { text: over.answer ?? '{"action":"vote","burnPercent":30,"rationale":"ok"}', chatId: "chat-1" };
      },
    };
    const deps: VoteDeps = {
      source: {
        round: async () => ({ round_id: "1", candidates: [], start_ns: null, end_ns: null, winner: over.winner === undefined ? 1 : over.winner }),
        disposition: async () => ({ status: over.status ?? "voting", closes_at_ns: over.closes ?? String((NOW + 60_000) * 1_000_000), burn_weight: "10", return_weight: "90", escrow_reserved: false, escrow_id: null }),
        position: async () => ({ registered: true, amount: over.amount ?? "500" }),
      },
      battleCount: async () => 1,
      arena: "arena.testnet",
      model,
      state: new PlayerState(null),
      now: () => NOW,
      sign: async (_a, c) => (calls.push(c), `hash${calls.length}`),
      log: (e) => logs.push(e),
      live: over.live ?? true,
    };
    return { deps, calls, logs, seen };
  };
  it("asks NEAR AI for the share and casts one vote with it", async () => {
    const { deps, calls, logs, seen } = setup();
    await voteOnce(agent, deps);
    expect(seen).toEqual([{ user: ME, battleId: 1, burnWeight: "10", returnWeight: "90" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ receiverId: "arena.testnet", methodName: "vote_lifecycle_disposition", args: { battle_id: "1", burn_percent: 30 } });
    expect(logs.at(-1)).toMatchObject({ event: "voted", burnPercent: 30, txHash: "hash1" });
    // A second round does not ask or vote again.
    await voteOnce(agent, deps);
    expect(calls).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });
  it("does not vote when it did not win, the vote is not open, or the answer is unusable", async () => {
    for (const over of [{ winner: null }, { status: "decided" as const }, { closes: String((NOW - 1) * 1_000_000) }, { amount: "0" }]) {
      const { deps, calls } = setup(over);
      await voteOnce(agent, deps);
      expect(calls, JSON.stringify(over)).toHaveLength(0);
    }
    const bad = setup({ answer: '{"action":"vote","burnPercent":900}' });
    await voteOnce(agent, bad.deps);
    expect(bad.calls).toHaveLength(0);
    expect(bad.logs.at(-1)).toMatchObject({ event: "vote_skipped", reason: "model_answer_invalid" });
    const silent = setup({ answer: null });
    await voteOnce(agent, silent.deps);
    expect(silent.logs.at(-1)).toMatchObject({ event: "vote_skipped", reason: "model_no_answer" });
  });
  it("only plans in a dry run and holds the battle before the vote leaves", async () => {
    const dry = setup({ live: false });
    await voteOnce(agent, dry.deps);
    expect(dry.calls).toHaveLength(0);
    expect(dry.logs.at(-1)).toMatchObject({ event: "vote_planned", burnPercent: 30 });

    const lost = setup();
    lost.deps.sign = async () => {
      throw new Error("the answer was lost");
    };
    await voteOnce(agent, lost.deps);
    expect(lost.logs.at(-1)).toMatchObject({ event: "vote_error" });
    await voteOnce(agent, lost.deps);
    expect(lost.seen).toHaveLength(1); // held back: not asked again straight away
  });
  it("stops trying a battle the contract refuses", async () => {
    const { deps, seen, logs } = setup();
    deps.sign = async () => {
      throw new Error("Smart contract panicked: Already voted");
    };
    await voteOnce(agent, deps);
    await voteOnce(agent, deps);
    expect(seen).toHaveLength(1);
    expect(logs.filter((l) => l.event === "vote_error")).toHaveLength(1);
  });
});
