// FIXTURE-ONLY: battles, balances, grants and receipts are synthetic. Not live evidence.
import { verifyNep413Signature } from "near-kit";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/mcp/actions/canonical.js";
import { ActionError, PREVIEW_TTL_MS, type UnsignedTransaction, buildPreview, validateRequest } from "../../src/mcp/actions/preview.js";
import { outcomeOf, type ReceiptOutcome, type ReceiptVerifier } from "../../src/mcp/actions/receipt.js";
import { ActionService, actionAuthorizationMessage } from "../../src/mcp/actions/service.js";
import { FixtureActionReadSource, type GrantView } from "../../src/mcp/actions/source.js";
import { ActionStore } from "../../src/mcp/actions/store.js";
import { callActionTool } from "../../src/mcp/actions/tools.js";
import { handleReadRequest } from "../../src/mcp/http.js";
import { handleMcpToolCall } from "../../src/mcp/server.js";
import { payoutDisplayState } from "../../src/mcp/payout-display.js";
import { AccessDeniedError, ToolInputError } from "../../src/mcp/tools.js";
import { FULL_ACCESS_KEYS, NOW, RECIPIENT, battle, makeSessions, makeSource, signRead } from "./fixtures.js";

const ctx = { network: "near-testnet", arena: "arena.testnet", payout: "payout.testnet", policy: "policy.testnet" };
const REP = "pepe.rep.testnet";
const LOCAL = "11".repeat(32);
const key = FixtureActionReadSource.key;

function approvedBattle(over: Record<string, unknown> = {}) {
  const b = battle(over);
  b.communities = b.communities.map((c) => ({
    ...c,
    audit_evidence_hash: "audit-hash",
    audit_expires_at_ms: String(NOW + 60 * 60_000),
    backing_evidence_hash: "backing-hash",
  }));
  return b;
}

function grant(over: Partial<GrantView> = {}): GrantView {
  return {
    user: "alice.testnet",
    delegate: "agent.testnet",
    version: "1",
    revoked: false,
    per_action_cap: "100",
    cumulative_cap: "500",
    gas_cap: String(200n * 10n ** 12n),
    expiry_ns: String(BigInt(NOW + 3_600_000) * 1_000_000n),
    ...over,
  };
}

function fixtureSource() {
  return new FixtureActionReadSource("near-testnet", {
    battles: new Map([[1, approvedBattle()], [2, approvedBattle({ locked: true })]]),
    positions: new Map([
      [key(1, 0, "alice.testnet"), { registered: true, amount: "0" }],
      [key(1, 0, "bob.testnet"), { registered: false, amount: "0" }],
    ]),
    balances: new Map([[key(REP, "alice.testnet"), 1_000n]]),
    entitlements: new Map([[key("backing.testnet", "alice.testnet"), 50n]]),
    grants: new Map([[key("alice.testnet", Array.from(Buffer.from(LOCAL, "hex")).join(",")), grant()]]),
    budgets: new Map([
      [key("alice.testnet", Array.from(Buffer.from(LOCAL, "hex")).join(",")), { authorized_limit: "500", consumed: "0", reserved: "0", available: "500" }],
    ]),
  });
}

class ScriptedReceipts implements ReceiptVerifier {
  next: ReceiptOutcome = { status: "pending", reason: "not final" };
  async check(): Promise<ReceiptOutcome> {
    return this.next;
  }
}

let clock = NOW;
let source: FixtureActionReadSource;
let receipts: ScriptedReceipts;
let service: ActionService;

beforeEach(() => {
  clock = NOW;
  source = fixtureSource();
  receipts = new ScriptedReceipts();
  service = new ActionService({
    source,
    ctx,
    store: new ActionStore(null),
    recipient: RECIPIENT,
    receipts,
    now: () => clock,
    verify: async (signed, params) =>
      FULL_ACCESS_KEYS.get(signed.accountId)?.has(signed.publicKey) === true &&
      verifyNep413Signature(signed, params, { nonceValidation: "none" }),
  });
});

const deposit = (over: Record<string, unknown> = {}) => ({ kind: "deposit", battleId: 1, community: 0, amount: "100", ...over });
const signFor = (hash: string, account = "alice.testnet", opts: { at?: number; recipient?: string } = {}) => ({
  kind: "user_signature" as const,
  ...signRead(account, { message: actionAuthorizationMessage(hash), at: opts.at ?? clock, ...(opts.recipient ? { recipient: opts.recipient } : {}) }),
});

describe("canonical previews", () => {
  it("binds asset, amount, recipient, network, costs, policy version and expiry, hashed canonically", async () => {
    const p = await buildPreview(validateRequest(deposit()), "alice.testnet", fixtureSource(), ctx, NOW);
    expect(p.version).toBe("action-preview-v1");
    expect(p.expiresAtMs - p.createdAtMs).toBe(PREVIEW_TTL_MS);
    expect(p.binding).toMatchObject({ battleId: 1, community: 0, amount: "100", arena: "arena.testnet", auditEvidenceHash: "audit-hash" });
    expect(p.transaction.receiverId).toBe(REP);
    expect(p.transaction.actions[0]?.args).toEqual({
      receiver_id: "arena.testnet",
      amount: "100",
      msg: JSON.stringify({ action: "lifecycle_deposit", battle_id: 1, community: 0 }),
    });
    expect(p.costs.attachedDepositYocto).toBe("1");
    expect(p.source).toBe("fixture");
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
  });

  it("refuses unsupported funding routes before anything is stored or built", async () => {
    for (const route of ["intents", "bridge", "oneclick"]) {
      await expect(service.preview("alice.testnet", deposit({ route }))).rejects.toMatchObject({ code: "unsupported_route" });
    }
  });

  it("refuses closed, unaudited, unregistered or unfunded deposits and unbacked payouts", async () => {
    await expect(service.preview("alice.testnet", deposit({ battleId: 2 }))).rejects.toMatchObject({ code: "battle_locked" });
    await expect(service.preview("bob.testnet", deposit())).rejects.toMatchObject({ code: "not_registered" });
    await expect(service.preview("alice.testnet", deposit({ amount: "1001" }))).rejects.toMatchObject({ code: "insufficient_balance" });
    source.data.battles.set(1, { ...approvedBattle(), communities: approvedBattle().communities.map((c) => ({ ...c, audit_expires_at_ms: String(NOW - 1) })) });
    await expect(service.preview("alice.testnet", deposit())).rejects.toMatchObject({ code: "audit_expired" });
    const payout = { kind: "payout", backing: "backing.testnet", amount: "51", destination: "0x" + "03".repeat(20) };
    await expect(service.preview("alice.testnet", payout)).rejects.toMatchObject({ code: "insufficient_entitlement" });
    await expect(service.preview("alice.testnet", { ...payout, destination: "0x" + "00".repeat(20) })).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("authorization and revalidation", () => {
  it("runs preview -> NEP-413 authorization -> revalidated prepare -> broadcast -> verified receipt", async () => {
    const r = await service.preview("alice.testnet", deposit());
    expect(r.status).toBe("previewed");
    // Preparing without an authorization is refused.
    await expect(service.prepare(r.actionId, "alice.testnet")).rejects.toThrow(/previewed/);
    const authorized = await service.authorize(r.actionId, "alice.testnet", signFor(r.previewHash));
    expect(authorized.status).toBe("authorized");
    const { record, transaction } = await service.prepare(r.actionId, "alice.testnet");
    expect(record.status).toBe("ready_to_sign");
    expect(transaction).toEqual(r.preview.transaction);
    const tx = "8".repeat(44);
    const broadcast = await service.reportBroadcast(r.actionId, "alice.testnet", tx);
    // A broadcast hash is pending until a verified receipt.
    expect(broadcast.status).toBe("broadcast");
    expect((await service.refresh(r.actionId, "alice.testnet")).status).toBe("broadcast");
    receipts.next = { status: "success" };
    expect((await service.refresh(r.actionId, "alice.testnet")).status).toBe("confirmed");
  });

  it("rejects signatures over another preview, from another account, for another recipient or replayed", async () => {
    const r = await service.preview("alice.testnet", deposit());
    const other = await service.preview("alice.testnet", deposit({ amount: "99" }));
    await expect(service.authorize(r.actionId, "alice.testnet", signFor(other.previewHash))).rejects.toThrow(/signature/);
    await expect(service.authorize(r.actionId, "alice.testnet", signFor(r.previewHash, "bob.testnet"))).rejects.toThrow(/account whose funds/);
    await expect(service.authorize(r.actionId, "alice.testnet", signFor(r.previewHash, "alice.testnet", { recipient: "evil.testnet" }))).rejects.toThrow(/signature/);
    const proof = signFor(r.previewHash);
    await service.authorize(r.actionId, "alice.testnet", proof);
    await expect(service.authorize(other.actionId, "alice.testnet", { ...proof })).rejects.toThrow(/nonce already used|signature/);
    // Model output or a missing proof is never authorization.
    await expect(service.authorize(other.actionId, "alice.testnet", { kind: "model_says_yes" } as never)).rejects.toThrow(/missing/);
    await expect(service.authorize(other.actionId, "alice.testnet", { kind: "grant" })).rejects.toThrow(/user's signature/);
  });

  it("only the previewing session can drive an action", async () => {
    const r = await service.preview("alice.testnet", deposit());
    await expect(service.authorize(r.actionId, "bob.testnet", signFor(r.previewHash))).rejects.toThrow(/another account/);
    await expect(service.status(r.actionId, "bob.testnet")).rejects.toThrow(/another account/);
  });

  it("expires a preview that is not authorized or prepared in time", async () => {
    const r = await service.preview("alice.testnet", deposit());
    const proof = signFor(r.previewHash);
    clock = NOW + PREVIEW_TTL_MS;
    expect((await service.authorize(r.actionId, "alice.testnet", proof)).status).toBe("expired");
    const late = await (async () => {
      clock = NOW;
      const again = await service.preview("alice.testnet", deposit({ amount: "98" }));
      await service.authorize(again.actionId, "alice.testnet", signFor(again.previewHash));
      clock = NOW + PREVIEW_TTL_MS + 1;
      return service.prepare(again.actionId, "alice.testnet");
    })();
    expect(late.record.status).toBe("expired");
  });

  it("rejects when balance, audit or lock state changed after authorization", async () => {
    const changes: Array<() => void> = [
      () => source.data.balances!.set(key(REP, "alice.testnet"), 10n),
      () => source.data.battles.set(1, { ...approvedBattle(), locked: true }),
      () => source.data.battles.set(1, { ...approvedBattle(), communities: approvedBattle().communities.map((c) => ({ ...c, audit_evidence_hash: "new-audit" })) }),
    ];
    for (const change of changes) {
      source = fixtureSource();
      service = new ActionService({ source, ctx, store: new ActionStore(null), recipient: RECIPIENT, receipts, now: () => clock, verify: async () => true });
      const r = await service.preview("alice.testnet", deposit());
      await service.authorize(r.actionId, "alice.testnet", { kind: "user_signature", accountId: "alice.testnet", publicKey: "ed25519:x", signature: "s", nonce: Buffer.from(signRead("alice.testnet").nonce, "base64").toString("base64") });
      change();
      await expect(service.prepare(r.actionId, "alice.testnet")).rejects.toThrow();
      expect((await service.status(r.actionId, "alice.testnet")).status).toBe("rejected");
    }
  });

  it("a grant prepares only the delegate's reserve call and a revoked grant blocks it", async () => {
    const request = deposit({ grant: { user: "alice.testnet", localId: LOCAL, mappingVersion: "2" } });
    // Only the grant's delegate can preview through it.
    await expect(service.preview("mallory.testnet", request)).rejects.toMatchObject({ code: "grant_invalid" });
    const r = await service.preview("agent.testnet", request);
    expect(r.preview.authorization).toBe("grant");
    expect(r.preview.signerId).toBe("agent.testnet");
    expect(r.preview.transaction.receiverId).toBe("policy.testnet");
    expect(r.preview.transaction.actions[0]?.methodName).toBe("reserve");
    await expect(service.authorize(r.actionId, "agent.testnet", signFor(r.previewHash))).rejects.toThrow(/grant/);
    await service.authorize(r.actionId, "agent.testnet", { kind: "grant" });
    source.data.grants!.set(key("alice.testnet", Array.from(Buffer.from(LOCAL, "hex")).join(",")), grant({ revoked: true }));
    await expect(service.prepare(r.actionId, "agent.testnet")).rejects.toMatchObject({ code: "grant_invalid" });
    expect((await service.status(r.actionId, "agent.testnet")).status).toBe("rejected");
    // Over the per-action cap is refused at preview.
    await expect(service.preview("agent.testnet", deposit({ amount: "101", grant: { user: "alice.testnet", localId: LOCAL, mappingVersion: "2" } }))).rejects.toMatchObject({
      code: "grant_invalid",
    });
  });
});

describe("receipts", () => {
  const expected: UnsignedTransaction = {
    signerId: "alice.testnet",
    receiverId: REP,
    actions: [{ type: "FunctionCall", methodName: "ft_transfer_call", args: { receiver_id: "arena.testnet", amount: "100", msg: "m" }, gas: "1", deposit: "1" }],
  };
  const chainTx = (over: Record<string, unknown> = {}, args: unknown = expected.actions[0]!.args) => ({
    status: { SuccessValue: "" },
    transaction: {
      signer_id: "alice.testnet",
      receiver_id: REP,
      actions: [{ FunctionCall: { method_name: "ft_transfer_call", args: Buffer.from(JSON.stringify(args)).toString("base64"), gas: 1, deposit: "1" } }],
      ...over,
    },
    receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }],
  });

  it("confirms only a final success of the exact prepared transaction", () => {
    expect(outcomeOf(chainTx(), expected)).toEqual({ status: "success" });
    expect(outcomeOf(chainTx({ receiver_id: "evil.testnet" }), expected).status).toBe("failure");
    expect(outcomeOf(chainTx({}, { receiver_id: "evil.testnet", amount: "100", msg: "m" }), expected).status).toBe("failure");
    expect(outcomeOf({ ...chainTx(), status: {} }, expected).status).toBe("pending");
    expect(outcomeOf({ ...chainTx(), receipts_outcome: [{ outcome: { status: { Failure: {} } } }] }, expected).status).toBe("failure");
  });
});

describe("shared MCP and HTTP boundary", () => {
  it("drives the same action through HTTP and MCP with one session; other accounts and missing sessions are refused", async () => {
    const sessions = makeSessions(() => clock);
    const alice = (await sessions.open(signRead("alice.testnet", { at: clock }))).token;
    const bob = (await sessions.open(signRead("bob.testnet", { at: clock }))).token;
    const deps = { arena: makeSource(), sessions, now: () => clock, actions: service };
    const created = await handleReadRequest(
      { method: "POST", url: "/actions", authorization: `Bearer ${alice}`, body: JSON.stringify({ request: deposit() }) },
      deps,
    );
    expect(created.status).toBe(200);
    const id = (JSON.parse(created.body) as { data: { actionId: string } }).data.actionId;
    const viaMcp = await handleMcpToolCall("action_status", { session: alice, actionId: id }, deps);
    expect(viaMcp.isError).toBeUndefined();
    const statusData = JSON.parse(viaMcp.content[0]!.text).data;
    expect(statusData.record.status).toBe("previewed");
    expect(statusData.attribution).toMatchObject({ user: "alice.testnet", signer: "alice.testnet", authorization: "user_signature" });
    await expect(callActionTool("action_status", { session: bob, actionId: id }, deps)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(callActionTool("action_status", { actionId: id }, deps)).rejects.toBeInstanceOf(AccessDeniedError);
    const unsupported = await handleReadRequest(
      { method: "POST", url: "/actions", authorization: `Bearer ${alice}`, body: JSON.stringify({ request: deposit({ route: "intents" }) }) },
      deps,
    );
    expect(unsupported.status).toBe(400);
    expect(unsupported.body).toMatch(/unsupported_route/);
    await expect(callActionTool("preview_action", { session: alice, request: deposit(), extra: 1 }, deps)).rejects.toBeInstanceOf(ToolInputError);
  });
});

describe("payout display states", () => {
  it("keeps reserved, broadcast, pending and confirmed apart", () => {
    expect(payoutDisplayState("Authorized")).toBe("reserved");
    expect(payoutDisplayState("Signed")).toBe("reserved");
    expect(payoutDisplayState("Broadcast")).toBe("broadcast");
    expect(payoutDisplayState("PendingFinality")).toBe("confirmation_pending");
    expect(payoutDisplayState("Confirmed")).toBe("confirmed");
    expect(payoutDisplayState("Restored")).toBe("restored");
  });
});

it("ActionError carries a machine-readable code", () => {
  expect(new ActionError("unsupported_route", "x").code).toBe("unsupported_route");
});

describe("register_position", () => {
  const register = (over: Record<string, unknown> = {}) => ({ kind: "register_position", battleId: 1, community: 0, ...over });

  it("prepares only the storage registration call, with an upper-bound deposit", async () => {
    const preview = await buildPreview(validateRequest(register()), "bob.testnet", source, ctx, NOW);
    expect(preview.kind).toBe("register_position");
    expect(preview.authorization).toBe("user_signature");
    expect(preview.accountId).toBe("bob.testnet");
    expect(preview.transaction).toMatchObject({
      signerId: "bob.testnet",
      receiverId: "arena.testnet",
      actions: [{ methodName: "register_lifecycle_position", args: { battle_id: 1, community: 0 } }],
    });
    expect(preview.transaction.actions).toHaveLength(1);
    expect(BigInt(preview.transaction.actions[0]!.deposit)).toBeGreaterThan(0n);
    expect(preview.costs.notes.join(" ")).toMatch(/storage/);
  });

  it("rejects extra fields, a grant and unknown communities", async () => {
    expect(() => validateRequest(register({ amount: "5" }))).toThrow(/unknown field/);
    expect(() => validateRequest(register({ grant: {} }))).toThrow(/unknown field/);
    expect(() => validateRequest(register({ community: 16 }))).toThrow(/community/);
    await expect(buildPreview(validateRequest(register({ community: 9 })), "bob.testnet", source, ctx, NOW)).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("refuses a missing or locked battle and an already registered position", async () => {
    await expect(buildPreview(validateRequest(register({ battleId: 77 })), "bob.testnet", source, ctx, NOW)).rejects.toMatchObject({ code: "battle_not_found" });
    await expect(buildPreview(validateRequest(register({ battleId: 2 })), "bob.testnet", source, ctx, NOW)).rejects.toMatchObject({ code: "battle_locked" });
    await expect(buildPreview(validateRequest(register()), "alice.testnet", source, ctx, NOW)).rejects.toMatchObject({ code: "already_registered" });
  });

  it("reports the position in the action attribution", async () => {
    const record = await service.preview("bob.testnet", register());
    const attribution = await service.attribution(record.actionId, "bob.testnet");
    expect(attribution).toMatchObject({ battleId: 1, community: 0, position: { registered: false } });
  });
});
