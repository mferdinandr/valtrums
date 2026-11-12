// FIXTURE-ONLY: battles, balances and views are synthetic. Not live evidence.
import { describe, expect, it } from "vitest";
import { ActionError, buildPreview, validateRequest, type ActionRequest } from "../../src/mcp/actions/preview.js";
import { FixtureActionReadSource, type JoinableAssetView } from "../../src/mcp/actions/source.js";
import type { DispositionView, ReleaseView } from "../../src/mcp/account-state.js";
import { FixtureStateSource } from "../../src/mcp/account-state.js";
import { callReadTool } from "../../src/mcp/tools.js";
import { battle, makeDeps, NOW } from "./fixtures.js";

const ctx = { network: "near-testnet", arena: "arena.testnet", payout: "payout.testnet", policy: null };
const key = FixtureActionReadSource.key;
const REP = "pepe.rep.testnet";
const TOKEN = "0x" + "a".repeat(40);
const SINK = "0x000000000000000000000000000000000000dead";
const ID = "ab".repeat(32);
const START = NOW + 3_600_000;

const joinable: JoinableAssetView = {
  chain_id: "46630", token_address: TOKEN, representation: "wallet.rep.testnet", custody_domain: "custody-v1", reference_chain_id: null, reference_address: null,
};

const disposition = (over: Partial<DispositionView> = {}): DispositionView => ({
  status: "voting", closes_at_ns: String(BigInt(NOW + 60_000) * 1_000_000n), burn_weight: "0", return_weight: "0", escrow_reserved: true, escrow_id: "cd".repeat(32),
  window_secs: "60", opens_at_ns: String(BigInt(NOW - 60_000) * 1_000_000n), burn_total: "0", return_total: "0", released: 0, total_releases: 0, ...over,
});

function mk(data: Partial<ConstructorParameters<typeof FixtureActionReadSource>[1]> = {}) {
  return new FixtureActionReadSource("near-testnet", { battles: new Map(), ...data });
}
const prev = (request: unknown, source: FixtureActionReadSource, caller = "alice.testnet", now = NOW) =>
  buildPreview(validateRequest(request) as ActionRequest, caller, source, ctx, now);
const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof ActionError) return e.code; throw e; }
  return "ok";
};
const funded = (b: ReturnType<typeof battle>, ...idx: number[]) => {
  idx.forEach((i) => { b.communities[i] = { ...b.communities[i]!, vault: "100" }; });
  return b;
};

describe("create_battle is a creator deposit (D41)", () => {
  const rep: JoinableAssetView = { ...joinable, representation: REP };
  const fundedSource = (over: Partial<ConstructorParameters<typeof FixtureActionReadSource>[1]> = {}) =>
    mk({
      joinable: new Map([[REP, rep]]),
      balances: new Map([[key(REP, "alice.testnet"), 500n]]),
      storage: new Map([["alice.testnet", 10n ** 23n]]),
      ...over,
    });
  const request = (over: Record<string, unknown> = {}) => ({ kind: "create_battle", representation: REP, amount: "100", mode: "PriceGain", startAtMs: String(START), ...over });

  it("is one ft_transfer_call of the creator's token with a lifecycle_create message", async () => {
    const p = await prev(request(), fundedSource());
    const call = p.transaction.actions[0]!;
    expect(p.transaction.receiverId).toBe(REP);
    expect(call.methodName).toBe("ft_transfer_call");
    expect(call.deposit).toBe("1");
    expect(call.args).toEqual({
      receiver_id: "arena.testnet",
      amount: "100",
      msg: JSON.stringify({ action: "lifecycle_create", mode: "PriceGain", start_at_ms: String(START) }),
    });
    expect(p.binding).toMatchObject({ arena: "arena.testnet", representation: REP, amount: "100", startAtMs: String(START) });
    expect(p.limitations.join(" ")).toContain(new Date(START).toISOString());
    expect(p.limitations.join(" ")).toContain("held in escrow");
  });
  it("refuses a token that is not joinable, a short balance and a short prepaid storage balance", async () => {
    expect(await code(prev(request(), fundedSource({ joinable: new Map() })))).toBe("not_joinable");
    expect(await code(prev(request({ amount: "501" }), fundedSource()))).toBe("insufficient_balance");
    expect(await code(prev(request(), fundedSource({ storage: new Map() })))).toBe("storage_balance_low");
  });
  it("rejects a start outside now+60s..now+7d and a missing or malformed start", async () => {
    for (const startAtMs of [String(NOW + 30_000), String(NOW + 8 * 24 * 3_600_000), String(NOW - 1)]) {
      expect(await code(prev(request({ startAtMs }), fundedSource()))).toBe("invalid_request");
    }
    for (const startAtMs of [undefined, "0", "-5", "1.5", "abc", "18446744073709551616", 1.5, {}]) {
      expect(() => validateRequest(request({ startAtMs }))).toThrow(ActionError);
    }
  });
  it("needs a positive base-unit amount, a representation and no assets list", () => {
    for (const amount of [undefined, "0", "-1", "1.5", "abc", 5]) expect(() => validateRequest(request({ amount }))).toThrow(ActionError);
    expect(() => validateRequest(request({ representation: "Not An Account" }))).toThrow(ActionError);
    expect(() => validateRequest(request({ assets: [] }))).toThrow(ActionError);
  });
});

describe("claim_escrow_refund (D41)", () => {
  const cancelled = () => battle({ communities: [], start_at_ms: String(START), cancelled: true });
  const escrow = { creator: "alice.testnet", representation: REP, amount: "100" };
  const request = { kind: "claim_escrow_refund", battleId: 1 };

  it("is one claim_lifecycle_escrow_refund by the creator of a cancelled battle", async () => {
    const p = await prev(request, mk({ battles: new Map([[1, cancelled()]]), escrows: new Map([[1, escrow]]) }));
    const call = p.transaction.actions[0]!;
    expect(p.transaction.receiverId).toBe("arena.testnet");
    expect(call.methodName).toBe("claim_lifecycle_escrow_refund");
    expect(call.args).toEqual({ battle_id: 1 });
    expect(call.deposit).toBe("1");
    expect(p.binding).toMatchObject({ battleId: 1, representation: REP, amount: "100" });
  });
  it("refuses a battle that is not cancelled, an account that is not the creator and a battle without escrow", async () => {
    const open = battle({ communities: [], start_at_ms: String(START), cancelled: false });
    expect(await code(prev(request, mk({ battles: new Map([[1, open]]), escrows: new Map([[1, escrow]]) })))).toBe("not_cancelled");
    expect(await code(prev(request, mk({ battles: new Map([[1, cancelled()]]), escrows: new Map([[1, escrow]]) }), "mallory.testnet"))).toBe("not_creator");
    expect(await code(prev(request, mk({ battles: new Map([[1, cancelled()]]) })))).toBe("nothing_to_refund");
  });
  it("validates the request shape", () => {
    expect(() => validateRequest({ kind: "claim_escrow_refund" })).toThrow(ActionError);
    expect(() => validateRequest({ kind: "claim_escrow_refund", battleId: 1, community: 0 })).toThrow(ActionError);
    expect(validateRequest({ kind: "claim_escrow_refund", battleId: 3 })).toEqual({ kind: "claim_escrow_refund", battleId: 3 });
  });
});

describe("prepay_storage", () => {
  it("is one payable lifecycle_storage_deposit on the arena", async () => {
    const p = await prev({ kind: "prepay_storage", amountYocto: "50000000000000000000000" }, mk());
    const call = p.transaction.actions[0]!;
    expect(p.transaction.receiverId).toBe("arena.testnet");
    expect(call.methodName).toBe("lifecycle_storage_deposit");
    expect(call.args).toEqual({});
    expect(call.deposit).toBe("50000000000000000000000");
    expect(p.costs.notes.join(" ")).toContain("not a bond");
  });
  it("refuses zero, a malformed amount and more than 10 NEAR", () => {
    for (const amountYocto of [undefined, "0", "-1", "1.5", 5, "10000000000000000000000001"]) {
      expect(() => validateRequest({ kind: "prepay_storage", amountYocto })).toThrow(ActionError);
    }
  });
});

describe("join_battle", () => {
  const open = () => battle({ communities: [], start_at_ms: String(START), cancelled: false });
  it("binds the joinable asset identity and the storage budget and names no index", async () => {
    const source = mk({ battles: new Map([[1, open()]]), joinable: new Map([["wallet.rep.testnet", joinable]]) });
    const p = await prev({ kind: "join_battle", battleId: 1, representation: "wallet.rep.testnet" }, source);
    const call = p.transaction.actions[0]!;
    expect(p.transaction.receiverId).toBe("arena.testnet");
    expect(call).toMatchObject({ methodName: "join_lifecycle_battle", args: { battle_id: 1, representation: "wallet.rep.testnet" }, deposit: "20000000000000000000000" });
    expect(p.binding.asset).toMatchObject({ tokenAddress: TOKEN, representation: "wallet.rep.testnet", chainId: "46630" });
    expect(p.limitations.join(" ")).toContain("adds a new community");
    expect(() => validateRequest({ kind: "join_battle", battleId: 1, representation: "wallet.rep.testnet", community: 0 })).toThrow(ActionError);
  });
  it("refuses a token that is not on the allowlist, a started, locked or cancelled battle and a full one", async () => {
    const joinableMap = new Map([["wallet.rep.testnet", joinable]]);
    const request = { kind: "join_battle", battleId: 1, representation: "wallet.rep.testnet" };
    expect(await code(prev({ ...request, representation: "ai.rep.testnet" }, mk({ battles: new Map([[1, open()]]), joinable: joinableMap })))).toBe("not_joinable");
    expect(await code(prev(request, mk({ battles: new Map([[1, open()]]), joinable: joinableMap }), "alice.testnet", START))).toBe("battle_started");
    expect(await code(prev(request, mk({ battles: new Map([[1, { ...open(), locked: true }]]), joinable: joinableMap })))).toBe("battle_locked");
    expect(await code(prev(request, mk({ battles: new Map([[1, { ...open(), cancelled: true }]]), joinable: joinableMap })))).toBe("battle_cancelled");
    expect(await code(prev(request, mk({ battles: new Map(), joinable: joinableMap })))).toBe("battle_not_found");
    const full = battle({ start_at_ms: String(START) });
    full.communities = Array.from({ length: 16 }, (_, i) => ({ ...full.communities[0]!, representation: `t${i}.rep.testnet` }));
    expect(await code(prev(request, mk({ battles: new Map([[1, full]]), joinable: joinableMap })))).toBe("battle_full");
  });
  it("reuses an existing community and is refused for an account that already joined", async () => {
    const b = battle({ start_at_ms: String(START) });
    b.communities[0] = { ...b.communities[0]!, representation: "wallet.rep.testnet" };
    const source = mk({ battles: new Map([[1, b]]), joinable: new Map([["wallet.rep.testnet", joinable]]), positions: new Map([[key(1, 0, "bob.testnet"), { registered: true, amount: "0" }]]) });
    const p = await prev({ kind: "join_battle", battleId: 1, representation: "wallet.rep.testnet" }, source);
    expect(p.limitations.join(" ")).toContain("existing community 0");
    expect(await code(prev({ kind: "join_battle", battleId: 1, representation: "wallet.rep.testnet" }, source, "bob.testnet"))).toBe("already_registered");
  });
});

describe("cancel_battle and claim_refund", () => {
  const cancellable = () => funded(battle({ start_at_ms: String(NOW - 1000), cancelled: false }), 0);
  it("prepares a no-deposit cancel only when the start passed, unlocked, below two funded communities", async () => {
    const p = await prev({ kind: "cancel_battle", battleId: 1 }, mk({ battles: new Map([[1, cancellable()]]) }));
    expect(p.transaction.actions[0]).toMatchObject({ methodName: "cancel_lifecycle_battle", args: { battle_id: 1 }, deposit: "0" });
    const refused = async (b: ReturnType<typeof battle>) => code(prev({ kind: "cancel_battle", battleId: 1 }, mk({ battles: new Map([[1, b]]) })));
    expect(await refused(battle({ start_at_ms: String(START) }))).toBe("battle_not_started");
    expect(await refused(battle())).toBe("not_cancellable");
    expect(await refused(funded(battle({ start_at_ms: String(NOW - 1000) }), 0, 1))).toBe("not_cancellable");
    expect(await refused({ ...cancellable(), locked: true })).toBe("battle_locked");
    expect(await refused({ ...cancellable(), cancelled: true })).toBe("battle_cancelled");
  });
  it("prepares a refund of the caller's own deposit with exactly one yocto", async () => {
    const b = { ...cancellable(), cancelled: true };
    const source = mk({ battles: new Map([[1, b]]), positions: new Map([[key(1, 0, "alice.testnet"), { registered: true, amount: "100" }]]) });
    const p = await prev({ kind: "claim_refund", battleId: 1, community: 0 }, source);
    expect(p.transaction.actions[0]).toMatchObject({ methodName: "claim_lifecycle_refund", args: { battle_id: 1, community: 0 }, deposit: "1" });
    expect(p.binding).toMatchObject({ amount: "100", representation: REP });
    expect(await code(prev({ kind: "claim_refund", battleId: 1, community: 0 }, source, "bob.testnet"))).toBe("nothing_to_refund");
    expect(await code(prev({ kind: "claim_refund", battleId: 1, community: 7 }, source))).toBe("invalid_request");
    expect(await code(prev({ kind: "claim_refund", battleId: 1, community: 0 }, mk({ battles: new Map([[1, cancellable()]]) })))).toBe("not_cancelled");
    expect(() => validateRequest({ kind: "claim_refund", battleId: 1, community: 16 })).toThrow(ActionError);
  });
  it("closes deposits and registration after a cancel or the start time", async () => {
    const b = battle({ start_at_ms: String(NOW - 1000) });
    b.communities = b.communities.map((c) => ({ ...c, audit_evidence_hash: "a", audit_expires_at_ms: String(NOW + 1e6), backing_evidence_hash: "b" }));
    const source = mk({ battles: new Map([[1, b], [2, { ...b, start_at_ms: String(START), cancelled: true }]]), balances: new Map([[key(REP, "alice.testnet"), 10n]]) });
    expect(await code(prev({ kind: "deposit", battleId: 1, community: 0, amount: "5" }, source))).toBe("battle_started");
    expect(await code(prev({ kind: "deposit", battleId: 2, community: 0, amount: "5" }, source))).toBe("battle_cancelled");
    expect(await code(prev({ kind: "register_position", battleId: 1, community: 0 }, source))).toBe("battle_started");
  });
});

describe("settle_battle", () => {
  const source = (recorded: number, total: number) => mk({ battles: new Map([[1, battle({ locked: true })]]), settlement: new Map([[1, { recorded, total }]]) });
  it("sizes the batch and the deposit from the progress and repeats until done", async () => {
    const first = await prev({ kind: "settle_battle", battleId: 1 }, source(0, 20));
    expect(first.transaction.actions[0]).toMatchObject({ methodName: "settle_lifecycle_battle", args: { battle_id: "1", max_entitlements: 15 }, deposit: (15n * 10n ** 22n).toString() });
    const second = await prev({ kind: "settle_battle", battleId: 1 }, source(15, 20));
    expect(second.transaction.actions[0]).toMatchObject({ args: { battle_id: "1", max_entitlements: 5 }, deposit: (5n * 10n ** 22n).toString() });
    expect(first.binding).not.toEqual(second.binding);
    expect(await code(prev({ kind: "settle_battle", battleId: 1 }, source(20, 20)))).toBe("already_settled");
  });
  it("refuses before a winner is recorded or for an unknown battle", async () => {
    expect(await code(prev({ kind: "settle_battle", battleId: 1 }, mk({ battles: new Map([[1, battle()]]) })))).toBe("winner_not_resolved");
    expect(await code(prev({ kind: "settle_battle", battleId: 9 }, mk()))).toBe("battle_not_found");
  });
});

describe("vote, escrow, execute and burn", () => {
  const winning = (over: Record<string, unknown> = {}) => battle({ locked: true, principal_community: 0, principal_amount: "100", ...over });
  const withD = (d: DispositionView | null, releases: ReleaseView[] = [], extra: Partial<ConstructorParameters<typeof FixtureActionReadSource>[1]> = {}) =>
    mk({
      battles: new Map([[1, winning()]]),
      dispositions: d ? new Map([[1, d]]) : undefined,
      releases: new Map([[1, releases]]),
      positions: new Map([[key(1, 0, "alice.testnet"), { registered: true, amount: "60" }]]),
      sinks: new Map([[REP, SINK]]),
      ...extra,
    });
  it("prepares a vote for a winning participant inside the window and refuses others", async () => {
    const p = await prev({ kind: "vote_disposition", battleId: 1, burnPercent: 100 }, withD(disposition()));
    expect(p.transaction.actions[0]).toMatchObject({ methodName: "vote_lifecycle_disposition", args: { battle_id: "1", burn_percent: 100 } });
    expect(p.binding).toMatchObject({ burnPercent: 100, weight: "60" });
    const back = await prev({ kind: "vote_disposition", battleId: 1, burnPercent: 0 }, withD(disposition()));
    expect(back.transaction.actions[0]!.args).toEqual({ battle_id: "1", burn_percent: 0 });
    expect(await code(prev({ kind: "vote_disposition", battleId: 1, burnPercent: 100 }, withD(disposition()), "bob.testnet"))).toBe("not_a_winner");
    expect(await code(prev({ kind: "vote_disposition", battleId: 1, burnPercent: 100 }, withD(disposition({ status: "decided" }))))).toBe("vote_closed");
    expect(await code(prev({ kind: "vote_disposition", battleId: 1, burnPercent: 100 }, withD(disposition({ status: "no_vote" }))))).toBe("vote_not_open");
    expect(await code(prev({ kind: "vote_disposition", battleId: 1, burnPercent: 100 }, withD(disposition({ closes_at_ns: String(BigInt(NOW) * 1_000_000n) }))))).toBe("vote_closed");
    expect(await code(prev({ kind: "vote_disposition", battleId: 1, burnPercent: 100 }, withD(null)))).toBe("winner_not_resolved");
    expect(() => validateRequest({ kind: "vote_disposition", battleId: 1, burnPercent: 101 })).toThrow(ActionError);
  });
  it("reserves the escrow once", async () => {
    const p = await prev({ kind: "reserve_escrow", battleId: 1 }, withD(disposition({ escrow_reserved: false })));
    expect(p.transaction.actions[0]).toMatchObject({ methodName: "reserve_lifecycle_escrow", args: { battle_id: "1" }, deposit: "10000000000000000000000" });
    expect(await code(prev({ kind: "reserve_escrow", battleId: 1 }, withD(disposition())))).toBe("already_done");
  });
  it("executes batches of at most 10 releases and refuses the unfinished states", async () => {
    const decided = (released: number, total: number, over: Partial<DispositionView> = {}) => disposition({ status: "decided", released, total_releases: total, ...over });
    const a = await prev({ kind: "execute_disposition", battleId: 1 }, withD(decided(0, 25)));
    expect(a.transaction.actions[0]).toMatchObject({ methodName: "execute_lifecycle_disposition", args: { battle_id: "1", max_releases: 10 }, deposit: (10n * 10n ** 22n).toString() });
    const c = await prev({ kind: "execute_disposition", battleId: 1 }, withD(decided(20, 25)));
    expect(c.transaction.actions[0]!.args).toEqual({ battle_id: "1", max_releases: 5 });
    expect(await code(prev({ kind: "execute_disposition", battleId: 1 }, withD(decided(25, 25))))).toBe("already_done");
    expect(await code(prev({ kind: "execute_disposition", battleId: 1 }, withD(decided(0, 3, { escrow_reserved: false }))))).toBe("escrow_not_reserved");
    expect(await code(prev({ kind: "execute_disposition", battleId: 1 }, withD(disposition())))).toBe("vote_not_open");
    expect(await code(prev({ kind: "execute_disposition", battleId: 1 }, withD(disposition({ status: "undecided_escrowed" }))))).toBe("nothing_to_execute");
    expect(await code(prev({ kind: "execute_disposition", battleId: 1 }, withD(disposition({ status: "no_winner" }))))).toBe("winner_not_resolved");
  });
  it("derives the burn request from the recorded burn release and the backing's frozen sink", async () => {
    const burn: ReleaseView = { id: ID, kind: "burn", beneficiary: null, amount: "40", recorded: true };
    const d = disposition({ status: "decided", released: 2, total_releases: 2 });
    const p = await prev({ kind: "request_dao_burn", battleId: 1 }, withD(d, [burn]));
    expect(p.transaction.receiverId).toBe("payout.testnet");
    expect(p.transaction.actions[0]).toMatchObject({
      methodName: "request_dao_burn", deposit: "30000000000000000000000",
      args: { backing: REP, holder: "arena.testnet", request_id: Array.from(Buffer.from(ID, "hex")), destination: Array.from(Buffer.from(SINK.slice(2), "hex")) },
    });
    expect(() => validateRequest({ kind: "request_dao_burn", battleId: 1, destination: SINK })).toThrow(ActionError);
    expect(await code(prev({ kind: "request_dao_burn", battleId: 1 }, withD(d, [{ ...burn, recorded: false }])))).toBe("release_not_recorded");
    expect(await code(prev({ kind: "request_dao_burn", battleId: 1 }, withD(d, [])))).toBe("nothing_to_execute");
    expect(await code(prev({ kind: "request_dao_burn", battleId: 1 }, withD(d, [burn], { sinks: new Map() })))).toBe("sink_not_set");
    expect(await code(buildPreview({ kind: "request_dao_burn", battleId: 1 }, "alice.testnet", withD(d, [burn]), { ...ctx, payout: null }, NOW))).toBe("not_configured");
  });
  it("prepares a late refund to a validated 20-byte address and never from a hash alone", async () => {
    const request = { kind: "late_refund", backing: "wallet.rep.testnet", amount: "7", destination: "0x" + "AB".repeat(20), requestId: ID };
    const p = await prev(request, mk());
    expect(p.transaction.actions[0]).toMatchObject({
      methodName: "request_late_refund",
      args: { backing: "wallet.rep.testnet", beneficiary: "alice.testnet", amount: "7", request_id: Array.from(Buffer.from(ID, "hex")), refund_address: Array.from(Buffer.from("ab".repeat(20), "hex")) },
    });
    for (const bad of [{ amount: "0" }, { amount: "1.5" }, { destination: "0x" + "0".repeat(40) }, { destination: "0x12" }, { requestId: "00".repeat(32) }, { requestId: "ab" }]) {
      expect(() => validateRequest({ ...request, ...bad })).toThrow(ActionError);
    }
  });
});

describe("inspect_endgame read tool", () => {
  it("shows settlement progress, the vote window, tally, escrow and execution progress", async () => {
    const deps = await makeDeps();
    const state = new FixtureStateSource("near-testnet", {
      settlement: new Map([[2, { recorded: 15, total: 20 }]]),
      dispositions: new Map([[2, disposition({ burn_weight: "40", return_weight: "20", released: 1, total_releases: 3, burn_total: "40", return_total: "20" })]]),
      releases: new Map([[2, [{ id: ID, kind: "burn" as const, beneficiary: null, amount: "40", recorded: true }]]]),
    });
    const out = await callReadTool("inspect_endgame", { battleId: 2 }, { ...deps, state });
    expect(out.data).toMatchObject({
      battleId: 2,
      settlement: { recorded: 15, total: 20, complete: false },
      vote: { status: "voting", open: true, burnWeight: "40", returnWeight: "20", windowSecs: "60" },
      escrow: { reserved: true },
      execution: { released: 1, total: 3, burnTotal: "40" },
      releases: [{ kind: "burn", recorded: true }],
    });
    expect(out.limitations.join(" ")).toContain("not a confirmed source burn");
  });
  it("needs a battle id and a configured state source", async () => {
    const deps = await makeDeps();
    await expect(callReadTool("inspect_endgame", {}, { ...deps, state: new FixtureStateSource("near-testnet", {}) })).rejects.toThrow("battleId");
    await expect(callReadTool("inspect_endgame", { battleId: 2 }, deps)).rejects.toThrow("not configured");
  });
});

describe("claim_entitlement and register_representation", () => {
  const BACKING = "backing.testnet";
  const withE = (registered: boolean, available = 50n) =>
    mk({
      entitlements: new Map([[key(BACKING, "alice.testnet"), available]]),
      registered: registered ? new Set([key(BACKING, "alice.testnet")]) : undefined,
    });
  it("prepares one yocto claim of an entitlement as representation tokens", async () => {
    const p = await prev({ kind: "claim_entitlement", backing: BACKING, amount: "30" }, withE(true));
    expect(p.transaction.receiverId).toBe(BACKING);
    expect(p.transaction.actions[0]).toMatchObject({ methodName: "claim_entitlement_as_representation", args: { amount: "30" }, deposit: "1" });
    expect(p.binding).toMatchObject({ backing: BACKING, beneficiary: "alice.testnet", amount: "30" });
  });
  it("refuses more than the entitlement and an unregistered account", async () => {
    expect(await code(prev({ kind: "claim_entitlement", backing: BACKING, amount: "51" }, withE(true)))).toBe("insufficient_entitlement");
    expect(await code(prev({ kind: "claim_entitlement", backing: BACKING, amount: "10" }, withE(false)))).toBe("not_registered");
  });
  it("registers only an account that is not registered yet", async () => {
    const p = await prev({ kind: "register_representation", backing: BACKING }, withE(false));
    expect(p.transaction.actions[0]).toMatchObject({ methodName: "storage_deposit", args: { account_id: "alice.testnet", registration_only: true } });
    expect(await code(prev({ kind: "register_representation", backing: BACKING }, withE(true)))).toBe("already_done");
  });
  it("rejects a claim without a valid amount", () => {
    expect(() => validateRequest({ kind: "claim_entitlement", backing: BACKING, amount: "0" })).toThrow(ActionError);
    expect(() => validateRequest({ kind: "claim_entitlement", backing: BACKING })).toThrow(ActionError);
  });
});
