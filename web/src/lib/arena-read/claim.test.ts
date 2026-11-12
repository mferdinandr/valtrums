// FIXTURE-ONLY: no chain is read.
import { describe, expect, it } from "vitest";
import { buildClaimReview, buildRegisterReview, claimRequest, readRegistered, REGISTER_DEPOSIT_YOCTO } from "./claim";

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
});
