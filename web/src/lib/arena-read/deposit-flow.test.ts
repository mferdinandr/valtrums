import { describe, expect, it } from "vitest";
import { previewMismatches } from "./create-review";
import { buildDepositReview, buildRegisterReview, creditOutcome, depositRequest, readCredit, registerRequest } from "./deposit-flow";

const ARENA = "arena.testnet";
const REP = "pepe.rep.testnet";

describe("register review", () => {
  it("is the exact storage-registration call", () => {
    const r = buildRegisterReview(ARENA, 7, 1);
    expect(r).toMatchObject({ ok: true, receiver: ARENA, method: "register_lifecycle_position", args: { battle_id: 7, community: 1 } });
    if (r.ok) expect(r.notes.join(" ")).toMatch(/not a stake/);
    expect(registerRequest(7, 1)).toEqual({ kind: "register_position", battleId: 7, community: 1 });
  });
  it("rejects bad ids", () => {
    expect(buildRegisterReview(ARENA, 0, 1).ok).toBe(false);
    expect(buildRegisterReview(ARENA, 1, 16).ok).toBe(false);
    expect(buildRegisterReview("", 1, 0).ok).toBe(false);
  });
});

describe("deposit review", () => {
  it("is an ft_transfer_call on the representation with the lifecycle_deposit message", () => {
    const r = buildDepositReview({ arena: ARENA, representation: REP, battleId: 7, community: 1, amount: "250" });
    expect(r).toMatchObject({ ok: true, receiver: REP, method: "ft_transfer_call", depositYocto: "1" });
    if (r.ok) {
      expect(r.args).toEqual({ receiver_id: ARENA, amount: "250", msg: JSON.stringify({ action: "lifecycle_deposit", battle_id: 7, community: 1 }) });
      expect(r.notes.join(" ")).toMatch(/refund/i);
    }
    expect(depositRequest(7, 1, "250")).toEqual({ kind: "deposit", battleId: 7, community: 1, amount: "250" });
  });
  it("keeps the amount an exact positive integer string", () => {
    for (const bad of ["", "0", "-1", "1.5", "1e3", " 5", "007", "1".repeat(40)]) {
      expect(buildDepositReview({ arena: ARENA, representation: REP, battleId: 1, community: 0, amount: bad }).ok).toBe(false);
    }
    expect(buildDepositReview({ arena: ARENA, representation: REP, battleId: 1, community: 0, amount: "340282366920938463463374607431768211455" }).ok).toBe(true);
  });
  it("blocks when the service preview differs from the reviewed call", () => {
    const r = buildDepositReview({ arena: ARENA, representation: REP, battleId: 7, community: 1, amount: "250" });
    if (!r.ok) throw new Error("review");
    const preview = (over: Record<string, unknown> = {}) => ({
      accountId: "bob.testnet",
      transaction: { signerId: "bob.testnet", receiverId: REP, actions: [{ methodName: "ft_transfer_call", args: r.args, deposit: "1", ...over }] },
    });
    expect(previewMismatches(preview(), r, "bob.testnet")).toEqual([]);
    expect(previewMismatches(preview({ args: { ...(r.args as object), amount: "251" } }), r, "bob.testnet")).toContain("the preview arguments differ from the reviewed arguments");
    expect(previewMismatches(preview({ args: { ...(r.args as object), receiver_id: "evil.testnet" } }), r, "bob.testnet")).toContain("the preview arguments differ from the reviewed arguments");
  });
});

describe("credit outcome", () => {
  it("separates a confirmed transaction from a credited position", () => {
    expect(creditOutcome("0", "250", "250")).toEqual({ state: "credited", delta: "250" });
    expect(creditOutcome("100", "350", "250")).toEqual({ state: "credited", delta: "250" });
    expect(creditOutcome("0", "100", "250")).toEqual({ state: "partial", delta: "100" });
    expect(creditOutcome("100", "100", "250")).toEqual({ state: "not_credited", delta: "0" });
    expect(creditOutcome("100", "40", "250").state).toBe("unknown");
    expect(creditOutcome(null, "250", "250").state).toBe("unknown");
  });
});

describe("readCredit", () => {
  it("reads the position from the action status attribution and never from the receipt", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ data: { record: { actionId: "a1" }, attribution: { position: { registered: true, amount: "250" } } } }), { status: 200 });
    expect(await readCredit("a1", { session: "t", wallet: {} as never, fetchImpl })).toEqual({ registered: true, amount: "250" });
  });
  it("is unknown when the service gives no position", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ data: { record: { actionId: "a1" }, attribution: { position: null } } }), { status: 200 });
    expect(await readCredit("a1", { session: "t", wallet: {} as never, fetchImpl })).toBeNull();
  });
});
