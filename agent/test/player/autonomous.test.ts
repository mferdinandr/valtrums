// FIXTURE-ONLY: fake arena reads, a fake NEAR AI client and a fake signer. No network.
import { describe, expect, it } from "vitest";
import { parseAutonomousAgents, playOnce, sweepOnce, type AutonomousAgentConfig, type AutonomousDeps, type FunctionCallRequest } from "../../src/player/autonomous.js";
import type { ModelInput, ModelProposer } from "../../src/player/model.js";
import { PlayerState } from "../../src/player/state.js";
import type { LifecycleBattleView } from "../../src/mcp/read-source.js";

const ARENA = "arena.testnet";
const NOW = 1_800_000_000_000;
const WALLET = "backing-wallet.testnet";
const CASHCAT = "backing-cashcat.testnet";
const ME = "agent1.testnet";

const agent = (over: Partial<AutonomousAgentConfig> = {}): AutonomousAgentConfig => ({
  account: ME, style: "crowd", keyEnv: "PLAYER_KEY_AGENT1", fractionBps: 2_500, maxPerHour: 6, maxModelCallsPerHour: 12, maxFailures: 3,
  intervalSecs: 15, scanBattles: 10, minStartLeadMs: 90_000, approvalWaitMs: 30_000, ...over,
});

const community = (representation: string, vault: string, approved = true) => ({
  chain_id: "46630", token_address: "0x0", representation, custody_domain: "d", reference_chain_id: null, reference_address: null, vault,
  audit_policy_hash: null,
  audit_evidence_hash: approved ? "a" : null,
  audit_expires_at_ms: approved ? String(NOW + 600_000) : null,
  backing_evidence_hash: approved ? "b" : null,
});

const battle = (communities: ReturnType<typeof community>[], over: Partial<LifecycleBattleView> = {}): LifecycleBattleView => ({
  creator: "c.testnet", protocol: "p", protocol_created: false, fee_bps: 10, creator_share_bps: 5000, mode: "PriceGain", communities,
  locked: false, observation_policy_version: null, observation_policy_hash: null, principal_community: null, principal_amount: null,
  start_at_ms: String(NOW + 300_000), cancelled: false, ...over,
});

/** A NEAR AI client that answers with `pick(input)`: a JSON string, or null for no answer. */
const ai = (pick: (input: ModelInput) => string | null, chatId: string | null = "chatcmpl-1"): ModelProposer & { seen: ModelInput[] } => {
  const seen: ModelInput[] = [];
  return {
    seen,
    propose: async (input) => {
      seen.push(input);
      return pick(input);
    },
    proposeDetailed: async (input) => {
      seen.push(input);
      const text = pick(input);
      return text === null ? null : { text, chatId };
    },
  };
};
const answer = (battleId: number, community: number, amount: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ action: "deposit", user: ME, battleId, community, amount, rationale: "because", ...over });

function setup(opts: { battles: Record<number, LifecycleBattleView>; balances: Record<string, bigint>; registered?: boolean; position?: string; live?: boolean; clock?: { t: number }; model?: ModelProposer }) {
  const calls: FunctionCallRequest[] = [];
  const logs: Record<string, unknown>[] = [];
  const clock = opts.clock ?? { t: NOW };
  const battles = opts.battles;
  const deps: AutonomousDeps = {
    arena: ARENA,
    source: {
      battle: async (id) => battles[id] ?? null,
      position: async () => ({ registered: opts.registered ?? false, amount: opts.position ?? "0" }),
      tokenBalance: async (token) => opts.balances[token] ?? 0n,
    },
    joinable: async () => [CASHCAT, WALLET],
    battleCount: async () => Math.max(0, ...Object.keys(battles).map(Number)),
    sign: async (_a, call) => {
      calls.push(call);
      // A join adds the community the way the arena would.
      if (call.methodName === "join_lifecycle_battle") {
        const b = battles[Number(call.args.battle_id)]!;
        b.communities.push(community(String(call.args.representation), "0", true));
      }
      return `hash${calls.length}`;
    },
    state: new PlayerState(null),
    now: () => clock.t,
    log: (e) => logs.push(e),
    live: opts.live ?? false,
    sleep: async (ms) => {
      clock.t += ms;
    },
    ...(opts.model ? { model: opts.model } : {}),
  };
  return { deps, calls, logs, clock };
}

describe("autonomous agent config", () => {
  it("accepts a valid agent and applies defaults", () => {
    const [a] = parseAutonomousAgents({ agents: [{ account: ME, style: "underdog", keyEnv: "PLAYER_KEY_AGENT1" }] });
    expect(a).toMatchObject({ account: ME, style: "underdog", fractionBps: 2_500, minStartLeadMs: 90_000 });
  });
  it("takes the old `strategy` name as the style hint and defaults to crowd", () => {
    expect(parseAutonomousAgents({ agents: [{ account: ME, strategy: "underdog", keyEnv: "PLAYER_KEY_A" }] })[0]).toMatchObject({ style: "underdog" });
    expect(parseAutonomousAgents({ agents: [{ account: ME, keyEnv: "PLAYER_KEY_A" }] })[0]).toMatchObject({ style: "crowd" });
  });
  it("rejects a key in the file, a bad account, a repeat, and any `mode` (it is always NEAR AI)", () => {
    expect(() => parseAutonomousAgents({ agents: [{ account: ME, keyEnv: "ed25519:abc" }] })).toThrow(/keyEnv/);
    expect(() => parseAutonomousAgents({ agents: [{ account: "Bad Account", keyEnv: "PLAYER_KEY_A" }] })).toThrow(/account/);
    const one = { account: ME, keyEnv: "PLAYER_KEY_A" };
    expect(() => parseAutonomousAgents({ agents: [one, one] })).toThrow(/repeats/);
    expect(() => parseAutonomousAgents({ agents: [{ ...one, mode: "rule" }] })).toThrow(/NEAR AI/);
  });
});

describe("autonomous agent (NEAR AI decides)", () => {
  const board = () => ({ 1: battle([community(WALLET, "100"), community(CASHCAT, "900")]) });
  const both = { [WALLET]: 1_000n, [CASHCAT]: 1_000n };

  it("does not play without a NEAR AI client", async () => {
    const { deps } = setup({ battles: board(), balances: both });
    expect(await playOnce(agent(), deps)).toMatchObject({ kind: "skipped", reason: "model_not_configured" });
  });

  it("follows the model's choice, records the chat id and plans register + deposit in a dry run", async () => {
    const model = ai(() => answer(1, 1, "200", { rationale: "back the big vault" }));
    const { deps, calls } = setup({ battles: board(), balances: both, model });
    const out = await playOnce(agent(), deps);
    expect(out.kind).toBe("dry_run");
    if (out.kind !== "dry_run") return;
    expect(out.community).toBe(1);
    expect(out.amount).toBe("200");
    expect(out.steps.map((s) => s.label)).toEqual(["register", "deposit"]);
    expect(out.rationale).toContain("NEAR AI: back the big vault");
    expect(out.rationale).toContain("/v1/signature/chatcmpl-1");
    expect(calls).toHaveLength(0);
  });

  it("never deposits again into a battle where the chain already shows its deposit", async () => {
    const model = ai(() => answer(1, 1, "200"));
    const { deps, calls } = setup({ battles: board(), balances: both, model, registered: true, position: "250", live: true });
    const out = await playOnce(agent(), deps);
    expect(out).toMatchObject({ kind: "skipped", reason: "already_deposited" });
    expect(calls).toHaveLength(0);
    // The note is kept per token: the next round no longer offers CASHCAT in that battle (WALLET, another token, stays open).
    await playOnce(agent(), deps);
    expect(model.seen[1]!.options.map((o) => o.community)).not.toContain(1);
    expect(calls).toHaveLength(0);
  });

  it("deposits once per token in a battle, and another token in the same battle is still open", async () => {
    let n = 0;
    const model = ai(() => (n++ === 0 ? answer(1, 1, "100") : answer(1, 0, "10")));
    const { deps, calls } = setup({ battles: board(), balances: both, model, registered: true, live: true });
    expect(await playOnce(agent(), deps)).toMatchObject({ kind: "played", community: 1 });
    // CASHCAT is done in battle 1; WALLET (community 0) is a different token, so it is still offered.
    expect(await playOnce(agent(), deps)).toMatchObject({ kind: "played", community: 0 });
    expect(model.seen[1]!.options).toEqual([{ battleId: 1, community: 0, vault: 100n }]);
    // Both tokens are done in that battle: nothing more to play there.
    expect(await playOnce(agent(), deps)).toMatchObject({ kind: "no_option" });
    expect(calls.filter((c) => c.methodName === "ft_transfer_call")).toHaveLength(2);
  });

  it("holds the battle back before the deposit leaves, so a lost answer cannot cause a second deposit", async () => {
    const model = ai(() => answer(1, 1, "200"));
    const ctx = setup({ battles: board(), balances: both, model, live: true });
    const { deps } = ctx;
    let heldAtSend = false;
    const sign = deps.sign;
    deps.sign = async (a, call) => {
      if (call.methodName === "ft_transfer_call") {
        heldAtSend = deps.state.isBlocked(`auto:${agent().account}:1:${CASHCAT}`, deps.now());
        throw new Error("the answer was lost");
      }
      return sign(a, call);
    };
    expect(await playOnce(agent(), deps)).toMatchObject({ kind: "error" });
    expect(heldAtSend).toBe(true);
    // Next round: the battle is held back, so nothing is sent again.
    const before = ctx.calls.length;
    await playOnce(agent(), deps);
    expect(ctx.calls.length).toBe(before);
  });

  it("offers the model only options it can fund, with the style hint and the largest limit", async () => {
    const model = ai(() => answer(1, 0, "10"));
    const { deps } = setup({ battles: board(), balances: { [WALLET]: 1_000n }, model });
    await playOnce(agent({ style: "underdog" }), deps);
    expect(model.seen[0]).toMatchObject({ strategy: "underdog", user: ME, maxAmount: 250n });
    expect(model.seen[0]!.options).toEqual([{ battleId: 1, community: 0, vault: 100n }]); // only WALLET is held
  });

  it("accepts the answer inside one json fence", async () => {
    const { deps } = setup({ battles: board(), balances: both, model: ai(() => "```json\n" + answer(1, 1, "200") + "\n```") });
    const out = await playOnce(agent(), deps);
    expect(out.kind === "dry_run" && out.community).toBe(1);
  });

  it.each([
    ["an amount above the option's limit", answer(1, 1, "251")],
    ["another agent's account", answer(1, 1, "10", { user: "someone.testnet" })],
    ["a community that was not offered", answer(1, 5, "10")],
    ["an extra field", answer(1, 1, "10", { memo: "hi" })],
    ["a zero amount", answer(1, 1, "0")],
    ["text that is not JSON", "I think community 1 looks good"],
  ])("sits the round out on %s", async (_name, text) => {
    const { deps, calls, logs } = setup({ battles: board(), balances: both, model: ai(() => text), live: true });
    const out = await playOnce(agent(), deps);
    expect(out).toMatchObject({ kind: "skipped", reason: "model_answer_invalid" });
    expect(calls).toHaveLength(0); // no rule fallback: nothing is chosen for the model
    expect(logs.some((l) => l.event === "model_answer_rejected")).toBe(true);
  });

  it("sits the round out when the model gives no answer", async () => {
    const { deps, calls } = setup({ battles: board(), balances: both, model: ai(() => null), live: true });
    expect(await playOnce(agent(), deps)).toMatchObject({ kind: "skipped", reason: "model_no_answer" });
    expect(calls).toHaveLength(0);
  });

  it("spares the API key: no second call about a battle after a bad answer, and an hourly cap", async () => {
    const bad = ai(() => "not json");
    const { deps } = setup({ battles: board(), balances: both, model: bad });
    expect(await playOnce(agent({ account: "budget1.testnet" }), deps)).toMatchObject({ reason: "model_answer_invalid" });
    expect(await playOnce(agent({ account: "budget1.testnet" }), deps)).toMatchObject({ kind: "no_option" }); // cooling off
    expect(bad.seen).toHaveLength(1);

    const capped = ai(() => "not json");
    const second = setup({ battles: { 1: battle([community(WALLET, "1")]) }, balances: both, model: capped });
    const a = agent({ maxModelCallsPerHour: 1 });
    await playOnce(a, second.deps); // the only call this hour; battle 1 cools off
    // A new battle appears, so there is something to ask about, but the hourly cap is used up.
    second.deps.source.battle = async (id) => (id <= 2 ? battle([community(WALLET, "1")]) : null);
    second.deps.battleCount = async () => 2;
    expect(await playOnce(a, second.deps)).toMatchObject({ kind: "skipped", reason: "model_call_limit" });
    expect(capped.seen).toHaveLength(1);
  });

  it("skips when it holds nothing and when the battle starts too soon", async () => {
    const model = ai(() => answer(1, 0, "10"));
    expect(await playOnce(agent(), setup({ battles: board(), balances: {}, model }).deps)).toMatchObject({ kind: "skipped", reason: "no_funds" });
    const soon = setup({ battles: { 1: battle([community(WALLET, "1")], { start_at_ms: String(NOW + 30_000) }) }, balances: { [WALLET]: 100n }, model });
    expect(await playOnce(agent(), soon.deps)).toMatchObject({ kind: "no_option" });
    expect(model.seen).toHaveLength(0); // the model is not asked when there is nothing to choose
  });

  it("joins a battle that lacks the token it holds (the join registers), waits for approvals and deposits", async () => {
    const model = ai(() => answer(1, 1, "100"));
    const { deps, calls } = setup({ battles: { 1: battle([community(CASHCAT, "500")]) }, balances: { [WALLET]: 400n }, model, live: true });
    const out = await playOnce(agent(), deps);
    expect(out.kind).toBe("played");
    expect(calls.map((c) => c.methodName)).toEqual(["join_lifecycle_battle", "ft_transfer_call"]);
    // The join already registered the position: a second register would be refused by the arena. The new community is
    // index 1, and the deposit uses the index the arena gave it.
    expect(JSON.parse(String(calls[1]!.args.msg))).toEqual({ action: "lifecycle_deposit", battle_id: 1, community: 1 });
    expect(calls[1]).toMatchObject({ receiverId: WALLET, deposit: "1" });
    expect(calls[1]!.args.amount).toBe("100");
  });

  it("plays a battle only once", async () => {
    const model = ai(() => answer(1, 0, "250"));
    const { deps, calls } = setup({ battles: { 1: battle([community(WALLET, "100")]) }, balances: { [WALLET]: 1_000n }, live: true, registered: true, model });
    expect((await playOnce(agent(), deps)).kind).toBe("played");
    expect((await playOnce(agent(), deps)).kind).toBe("no_option");
    expect(calls.filter((c) => c.methodName === "ft_transfer_call")).toHaveLength(1);
  });

  it("does not deposit while approvals are missing and backs off from that battle", async () => {
    const model = ai(() => answer(1, 0, "250"));
    const { deps, calls } = setup({ battles: { 1: battle([community(WALLET, "100", false)]) }, balances: { [WALLET]: 1_000n }, live: true, registered: true, model });
    expect(await playOnce(agent({ approvalWaitMs: 10_000 }), deps)).toMatchObject({ kind: "skipped", reason: "approvals_pending" });
    expect(calls).toHaveLength(0);
    expect((await playOnce(agent(), deps)).kind).toBe("no_option"); // blocked for ten minutes
  });

  it("stops after too many failures", async () => {
    const { deps } = setup({ battles: board(), balances: both, model: ai(() => answer(1, 0, "10")) });
    deps.state.recordFailure();
    deps.state.recordFailure();
    expect(await playOnce(agent({ maxFailures: 2 }), deps)).toMatchObject({ kind: "skipped", reason: "circuit_open" });
  });
});

describe("sweep to the owner", () => {
  const sweepAgent = (over: Partial<AutonomousAgentConfig> = {}): AutonomousAgentConfig => agent({ sweepTo: "owner.testnet", keepWhole: 10, ...over });
  const E18 = 10n ** 18n;
  const mk = (balances: Record<string, bigint>, registered = true, live = true) => {
    const calls: FunctionCallRequest[] = [];
    const logs: Record<string, unknown>[] = [];
    return {
      calls,
      logs,
      deps: {
        joinable: async () => [CASHCAT, WALLET],
        balance: async (t: string) => balances[t] ?? 0n,
        registered: async () => registered,
        sign: async (_a: AutonomousAgentConfig, c: FunctionCallRequest) => {
          calls.push(c);
          return `h${calls.length}`;
        },
        log: (e: Record<string, unknown>) => logs.push(e),
        live,
      },
    };
  };

  it("requires keepWhole with sweepTo and refuses sweeping to itself", () => {
    const base = { account: ME, keyEnv: "PLAYER_KEY_A" };
    expect(() => parseAutonomousAgents({ agents: [{ ...base, sweepTo: "owner.testnet" }] })).toThrow(/keepWhole/);
    expect(() => parseAutonomousAgents({ agents: [{ ...base, sweepTo: ME, keepWhole: 1 }] })).toThrow(/differ/);
    expect(parseAutonomousAgents({ agents: [{ ...base, sweepTo: "owner.testnet", keepWhole: 25 }] })[0]).toMatchObject({ sweepTo: "owner.testnet", keepWhole: 25 });
  });

  it("sends only the balance above keepWhole, per token", async () => {
    const { deps, calls } = mk({ [WALLET]: 110n * E18, [CASHCAT]: 4n * E18 });
    const out = await sweepOnce(sweepAgent(), deps);
    expect(out).toHaveLength(1); // CASHCAT is under the floor
    expect(calls[0]).toMatchObject({ receiverId: WALLET, methodName: "ft_transfer", deposit: "1" });
    expect(calls[0]!.args).toEqual({ receiver_id: "owner.testnet", amount: (100n * E18).toString() });
  });

  it("does nothing without sweepTo, in a dry run it only plans, and it skips an unregistered owner", async () => {
    expect(await sweepOnce(agent(), mk({ [WALLET]: 110n * E18 }).deps)).toEqual([]);
    const dry = mk({ [WALLET]: 110n * E18 }, true, false);
    expect((await sweepOnce(sweepAgent(), dry.deps))[0]).toMatchObject({ status: "planned" });
    expect(dry.calls).toHaveLength(0);
    const unreg = mk({ [WALLET]: 110n * E18 }, false);
    expect((await sweepOnce(sweepAgent(), unreg.deps))[0]).toMatchObject({ status: "owner_not_registered" });
    expect(unreg.calls).toHaveLength(0);
  });
});
