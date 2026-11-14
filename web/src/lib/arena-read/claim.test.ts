// FIXTURE-ONLY: no chain is read.
import { describe, expect, it } from "vitest";
import { buildClaimBatch, buildClaimReview, outcomeFailure, buildRegisterReview, buildSettleReview, claimRequest, readEntitlement, readRegistered, REGISTER_DEPOSIT_YOCTO, settleBatch, settleRequest } from "./claim";

describe("claim to the NEAR wallet", () => {
  it("is one yocto call with the amount, matching the action service's preview", () => {
    expect(buildClaimReview("wallet.rep.testnet", "30")).toMatchObject({
      ok: true,
      receiver: "wallet.rep.testnet",
      method: "claim_entitlement_as_representation",
      args: { amount: "30" },
      depositYocto: "1",
      gasTgas: "30",
    });
    expect(claimRequest("wallet.rep.testnet", "30")).toEqual({ kind: "claim_entitlement", backing: "wallet.rep.testnet", amount: "30" });
  });
  it("refuses a zero or malformed amount and a bad contract id", () => {
    expect(buildClaimReview("wallet.rep.testnet", "0").ok).toBe(false);
    expect(buildClaimReview("wallet.rep.testnet", "1.5").ok).toBe(false);
    expect(buildClaimReview("", "5").ok).toBe(false);
  });
  it("registers with a registration-only storage deposit", () => {
    expect(buildRegisterReview("wallet.rep.testnet", "alice.testnet")).toMatchObject({
      ok: true,
      method: "storage_deposit",
      args: { account_id: "alice.testnet", registration_only: true },
      depositYocto: REGISTER_DEPOSIT_YOCTO,
    });
    expect(buildRegisterReview("wallet.rep.testnet", "").ok).toBe(false);
  });
  it("reads registration from storage_balance_of", async () => {
    const answer = (value: unknown) => async () => new Response(JSON.stringify({ result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } }));
    const original = globalThis.fetch;
    try {
      globalThis.fetch = answer({ total: "1", available: "0" }) as never;
      expect(await readRegistered("https://rpc", "t.testnet", "a.testnet")).toBe(true);
      globalThis.fetch = answer(null) as never;
      expect(await readRegistered("https://rpc", "t.testnet", "a.testnet")).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
  it("reads the entitlement as a base-unit string and falls back to zero", async () => {
    const answer = (value: unknown) => async () => new Response(JSON.stringify({ result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } }));
    const original = globalThis.fetch;
    try {
      globalThis.fetch = answer("60") as never;
      expect(await readEntitlement("https://rpc", "t.testnet", "a.testnet")).toBe("60");
      globalThis.fetch = answer(null) as never;
      expect(await readEntitlement("https://rpc", "t.testnet", "a.testnet")).toBe("0");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("settle the prizes", () => {
  it("sizes the batch and the deposit from the progress", () => {
    expect(settleBatch({ recorded: 0, total: 4 })).toBe(4);
    expect(settleBatch({ recorded: 0, total: 20 })).toBe(15);
    expect(settleBatch({ recorded: 15, total: 20 })).toBe(5);
    expect(settleBatch({ recorded: 4, total: 4 })).toBe(0);
    const r = buildSettleReview("arena.testnet", 35, { recorded: 0, total: 4 });
    expect(r).toMatchObject({ ok: true, method: "settle_lifecycle_battle", args: { battle_id: "35", max_entitlements: 4 }, gasTgas: "300" });
    if (r.ok) expect(r.depositYocto).toBe((4n * 10n ** 22n).toString());
    expect(settleRequest(35)).toEqual({ kind: "settle_battle", battleId: 35 });
  });
  it("refuses when everything is recorded", () => {
    expect(buildSettleReview("arena.testnet", 35, { recorded: 4, total: 4 }).ok).toBe(false);
  });
});

describe("claim all in one approval", () => {
  const A = "cashcat.rep.testnet";
  const B = "wallet.rep.testnet";
  it("builds one transaction per token, registering first only where the account is not registered", () => {
    const out = buildClaimBatch("alice.testnet", [
      { backing: A, available: "30", registered: true },
      { backing: B, available: "70", registered: false },
    ]);
    if (!out.ok) throw new Error("expected a batch");
    expect(out.transactions.map((t) => t.receiverId)).toEqual([A, B]);
    expect(out.transactions[0]?.actions.map((a) => a.params.methodName)).toEqual(["claim_entitlement_as_representation"]);
    expect(out.transactions[1]?.actions.map((a) => a.params.methodName)).toEqual(["storage_deposit", "claim_entitlement_as_representation"]);
    expect(out.transactions[1]?.actions[0]?.params).toMatchObject({ args: { account_id: "alice.testnet", registration_only: true }, deposit: REGISTER_DEPOSIT_YOCTO });
    expect(out.transactions[0]?.actions[0]?.params).toMatchObject({ args: { amount: "30" }, deposit: "1", gas: "30000000000000" });
  });
  it("refuses a malformed amount or contract instead of sending a partial batch", () => {
    expect(buildClaimBatch("alice.testnet", [{ backing: A, available: "0", registered: true }]).ok).toBe(false);
    expect(buildClaimBatch("alice.testnet", [{ backing: A, available: "5", registered: true }, { backing: "", available: "5", registered: true }]).ok).toBe(false);
    expect(buildClaimBatch("", [{ backing: A, available: "5", registered: false }]).ok).toBe(false);
  });
  it("finds a failure in one outcome or in a list of them", () => {
    expect(outcomeFailure({ status: { SuccessValue: "" } })).toBeNull();
    expect(outcomeFailure([{ status: { SuccessValue: "" } }, { status: { Failure: { ActionError: { kind: "x" } } } }])).toContain("ActionError");
    expect(outcomeFailure(undefined)).toBeNull();
  });
});
