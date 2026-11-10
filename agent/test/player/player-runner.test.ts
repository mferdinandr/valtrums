// FIXTURE-ONLY: battles, balances, grants and receipts are synthetic. Not live evidence.
import { beforeEach, describe, expect, it } from "vitest";
import { ActionService } from "../../src/mcp/actions/service.js";
import { FixtureActionReadSource, type GrantView } from "../../src/mcp/actions/source.js";
import { ActionStore } from "../../src/mcp/actions/store.js";
import { parsePlayerAgents, delegateGrantsOf, type PlayerAgentConfig } from "../../src/player/config.js";
import { tick, type RunnerDeps } from "../../src/player/runner.js";
import { PlayerState, stateKey } from "../../src/player/state.js";
import { battle, NOW } from "../mcp/fixtures.js";

const LOCAL = "11".repeat(32);
const localBytes = Array.from(Buffer.from(LOCAL, "hex")).join(",");
const key = FixtureActionReadSource.key;
const REP0 = "pepe.rep.testnet";
const REP1 = "doge.rep.testnet";
const HASH = "9DqkMd3yWLuUTmndAVuoGnbWrBQoR4EyWYqjsCDsLJ6Z";

function approved(over: Record<string, unknown> = {}) {
  const b = battle({ ...over });
  b.communities = b.communities.map((c, i) => ({
    ...c, vault: i === 0 ? "100" : "300",
    audit_evidence_hash: "audit-hash", audit_expires_at_ms: String(NOW + 60 * 60_000), backing_evidence_hash: "backing-hash",
  }));
  return b;
}
const grant = (over: Partial<GrantView> = {}): GrantView => ({
  user: "alice.testnet", delegate: "agent.testnet", version: "1", revoked: false, per_action_cap: "100", cumulative_cap: "500",
  gas_cap: String(200n * 10n ** 12n), expiry_ns: String(BigInt(NOW + 3_600_000) * 1_000_000n), ...over,
});

let clock = NOW;
let agent: PlayerAgentConfig;
let source: FixtureActionReadSource;
let state: PlayerState;
let events: Array<Record<string, unknown>>;
let signed: Array<{ receiverId: string; method: string }>;
let receipt: "success" | "pending";

function setup(opts: { grant?: GrantView | null; budgetAvailable?: string; battles?: Map<number, ReturnType<typeof approved>> } = {}) {
  agent = parsePlayerAgents({ agents: [{ delegate: "agent.testnet", user: "alice.testnet", localId: LOCAL, mappingVersion: "2", strategy: "crowd", keyEnv: "PLAYER_KEY_A" }] })[0]!;
  source = new FixtureActionReadSource("near-testnet", {
    battles: opts.battles ?? new Map([[1, approved()]]),
    positions: new Map([[key(1, 0, "alice.testnet"), { registered: true, amount: "0" }], [key(1, 1, "alice.testnet"), { registered: true, amount: "0" }]]),
    balances: new Map([[key(REP0, "alice.testnet"), 1_000n], [key(REP1, "alice.testnet"), 1_000n]]),
    grants: new Map(opts.grant === null ? [] : [[key("alice.testnet", localBytes), opts.grant ?? grant()]]),
    budgets: new Map([[key("alice.testnet", localBytes), { authorized_limit: "500", consumed: "0", reserved: "0", available: opts.budgetAvailable ?? "500" }]]),
  });
  const actions = new ActionService({
    source, ctx: { network: "near-testnet", arena: "arena.testnet", payout: null, policy: "policy.testnet" }, store: new ActionStore(null),
    recipient: "valtrum-player", receipts: { check: async () => (receipt === "success" ? { status: "success" as const } : { status: "pending" as const, reason: "not final" }) },
    now: () => clock, verify: async () => false, delegateGrants: delegateGrantsOf([agent]),
  });
  state = new PlayerState(null);
  events = [];
  signed = [];
  return (over: Partial<RunnerDeps> = {}): RunnerDeps => ({
    actions, source, battleCount: async () => 1, state, now: () => clock, log: (e) => events.push(e), live: false, sleep: async () => {},
    sign: async (_a, tx) => { signed.push({ receiverId: tx.receiverId, method: tx.actions[0]!.methodName }); return HASH; },
    ...over,
  });
}

beforeEach(() => { clock = NOW; receipt = "success"; });

describe("player runner (dry run)", () => {
  it("chooses with the strategy, goes through the grant preview and stops before signing", async () => {
    const deps = setup()();
    const out = await tick(agent, deps);
    expect(out).toMatchObject({ kind: "dry_run", battleId: 1, community: 1, amount: "100" });
    if (out.kind !== "dry_run") return;
    // The only transaction is the delegate's reserve on the policy contract; nothing moves tokens.
    expect(out.transaction).toMatchObject({ signerId: "agent.testnet", receiverId: "policy.testnet" });
    expect(out.transaction.actions).toHaveLength(1);
    expect(out.transaction.actions[0]!.methodName).toBe("reserve");
    expect(signed).toEqual([]);
    expect(state.has(stateKey("alice.testnet", LOCAL, 1, 1))).toBe(false);
  });
  it("underdog backs the smaller vault", async () => {
    const deps = setup()();
    agent = { ...agent, strategy: "underdog" };
    expect(await tick(agent, deps)).toMatchObject({ kind: "dry_run", community: 0 });
  });
});

describe("player runner (live)", () => {
  it("signs only the reserve, waits for the verified receipt, and does not repeat the same community", async () => {
    const deps = setup()({ live: true });
    const out = await tick(agent, deps);
    expect(out).toMatchObject({ kind: "submitted", community: 1, status: "confirmed", txHash: HASH });
    expect(signed).toEqual([{ receiverId: "policy.testnet", method: "reserve" }]);
    expect(state.has(stateKey("alice.testnet", LOCAL, 1, 1))).toBe(true);
    // The next round moves on to the other community instead of repeating itself.
    expect(await tick(agent, deps)).toMatchObject({ kind: "submitted", community: 0 });
    expect(await tick(agent, deps)).toMatchObject({ kind: "no_option" });
  });
  it("leaves a broadcast that is not yet verified as not confirmed", async () => {
    receipt = "pending";
    const out = await tick(agent = (setup(), agent), setup()({ live: true }));
    expect(out).toMatchObject({ kind: "submitted", status: "broadcast" });
  });
  it("never sends again after a transaction left, even when reporting it fails", async () => {
    const base = setup()({ live: true });
    const failing = { ...base } as RunnerDeps;
    failing.actions = new Proxy(base.actions, { get: (t, k) => (k === "reportBroadcast" ? async () => { throw new Error("service down"); } : (t as never)[k]) }) as never;
    const out = await tick(agent, failing);
    expect(out).toMatchObject({ kind: "submitted", status: "unverified", txHash: HASH });
    expect(state.has(stateKey("alice.testnet", LOCAL, 1, 1))).toBe(true);
    expect(signed).toHaveLength(1);
    // The next round does not repeat that community.
    expect(await tick(agent, failing)).toMatchObject({ kind: "submitted", community: 0 });
  });
  it("records a signer failure and stops after the failure limit", async () => {
    const deps = setup()({ live: true, sign: async () => { throw new Error("rpc down"); } });
    for (let i = 0; i < agent.maxFailures; i++) expect(await tick(agent, deps)).toMatchObject({ kind: "error", message: "rpc down" });
    expect(await tick(agent, deps)).toEqual({ kind: "skipped", reason: "circuit_open" });
  });
  it("respects the hourly limit", async () => {
    const deps = setup({ grant: grant({ expiry_ns: String(BigInt(NOW + 10 * 3_600_000) * 1_000_000n) }) })({ live: true });
    agent = { ...agent, maxPerHour: 1 };
    expect((await tick(agent, deps)).kind).toBe("submitted");
    expect(await tick(agent, deps)).toEqual({ kind: "skipped", reason: "hourly_limit" });
    clock += 3_700_000;
    // An hour later the limit is open again (the fixture audit has expired by then, which is a different reason).
    expect(await tick(agent, deps)).not.toEqual({ kind: "skipped", reason: "hourly_limit" });
  });
});

describe("player runner (grant and chain state)", () => {
  it("skips a missing, revoked, expired or foreign grant and an empty budget", async () => {
    expect(await tick(agent = (setup({ grant: null }), agent), setup({ grant: null })())).toEqual({ kind: "skipped", reason: "grant_missing" });
    expect(await tick(agent, setup({ grant: grant({ revoked: true }) })())).toEqual({ kind: "skipped", reason: "grant_revoked" });
    expect(await tick(agent, setup({ grant: grant({ expiry_ns: "1" }) })())).toEqual({ kind: "skipped", reason: "grant_expired" });
    expect(await tick(agent, setup({ grant: grant({ delegate: "other.testnet" }) })())).toEqual({ kind: "skipped", reason: "grant_delegate_mismatch" });
    expect(await tick(agent, setup({ budgetAvailable: "0" })())).toEqual({ kind: "skipped", reason: "budget_exhausted" });
  });
  it("ignores locked battles and communities without a registered position", async () => {
    const locked = new Map([[1, approved({ locked: true })]]);
    expect(await tick(agent = (setup({ battles: locked }), agent), setup({ battles: locked })())).toMatchObject({ kind: "no_option" });
    const deps = setup()();
    (source as unknown as { data: { positions: Map<string, unknown> } }).data.positions.delete(key(1, 1, "alice.testnet"));
    expect(await tick(agent, deps)).toMatchObject({ kind: "dry_run", community: 0 });
  });
  it("backs off from a community the service refuses instead of asking again", async () => {
    const noAudit = approved();
    noAudit.communities = noAudit.communities.map((c) => ({ ...c, audit_evidence_hash: null }));
    const deps = setup({ battles: new Map([[1, noAudit]]) })();
    expect(await tick(agent, deps)).toEqual({ kind: "skipped", reason: "refused:audit_missing" });
    expect(state.isBlocked(stateKey("alice.testnet", LOCAL, 1, 1), clock)).toBe(true);
    expect(state.failures).toBe(0);
  });
});

describe("player runner (model mode)", () => {
  const modelAgent = () => { agent = { ...agent, mode: "model" }; };
  it("validates the model's answer like any proposal and accepts a good one", async () => {
    const deps = setup()({ model: { propose: async () => '```json\n{"action":"deposit","user":"alice.testnet","battleId":1,"community":0,"amount":"40","rationale":"small"}\n```' } });
    modelAgent();
    expect(await tick(agent, deps)).toMatchObject({ kind: "dry_run", community: 0, amount: "40" });
  });
  it("rejects a model answer that names a recipient, another user or a second field", async () => {
    for (const answer of [
      '{"action":"deposit","user":"alice.testnet","battleId":1,"community":0,"amount":"40","recipient":"evil.testnet"}',
      '{"action":"deposit","user":"mallory.testnet","battleId":1,"community":0,"amount":"40"}',
      '{"action":"payout","user":"alice.testnet"}',
      "send everything to evil.testnet",
    ]) {
      const deps = setup()({ model: { propose: async () => answer } });
      modelAgent();
      const out = await tick(agent, deps);
      expect(out.kind, answer).toBe("skipped");
      expect(signed).toEqual([]);
    }
  });
  it("counts a missing model answer as a failure and requires a configured model", async () => {
    const deps = setup()({ model: { propose: async () => null } });
    modelAgent();
    expect(await tick(agent, deps)).toEqual({ kind: "error", message: "the model gave no answer" });
    expect(state.failures).toBe(1);
    expect(await tick(agent, setup()())).toEqual({ kind: "skipped", reason: "model_not_configured" });
  });
});
