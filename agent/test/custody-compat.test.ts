// FIXTURE-ONLY: synthetic addresses and code hashes. Not a statement about any deployed contract.
import { describe, expect, it } from "vitest";
import { assessCustody, retiredCustodyReason, type CustodyFacts } from "../src/custody-compat.js";

const A = (n: string) => `0x${n.repeat(40)}`;
const facts = (over: Partial<CustodyFacts> = {}): CustodyFacts => ({
  depositContract: A("c"), tokenHolder: A("a"), payoutSender: A("a"), holderCodeHash: null, ...over,
});

describe("custody compatibility gate", () => {
  it("accepts tokens held by the account the payout contract signs for", () => {
    expect(assessCustody(facts())).toEqual({ spendable: true, reasons: [] });
    expect(assessCustody(facts({ tokenHolder: A("A"), payoutSender: A("a") })).spendable).toBe(true); // case is not identity
  });

  it("refuses deposits that stay in a contract the signer does not control (deposit-only custody)", () => {
    const v = assessCustody(facts({ depositContract: A("c"), tokenHolder: A("c"), holderCodeHash: "0x" + "11".repeat(32) }));
    expect(v.spendable).toBe(false);
    expect(v.reasons[0]).toMatch(/cannot spend them/);
  });

  it("does not treat a different prefunded balance as proof: the holder must be the signer", () => {
    expect(assessCustody(facts({ tokenHolder: A("b") })).spendable).toBe(false);
  });

  it("never assumes that a signing key controls a contract-code sender", () => {
    const v = assessCustody(facts({ holderCodeHash: "0x" + "22".repeat(32) }));
    expect(v.spendable).toBe(false);
    expect(v.reasons[0]).toMatch(/has not been reviewed as spendable/);
  });

  it("refuses malformed addresses instead of normalizing them away", () => {
    expect(assessCustody(facts({ tokenHolder: "0x1234" }))).toEqual({ spendable: false, reasons: ["custody addresses are not valid 20-byte hex addresses"] });
  });

  it("refuses a retired deposit contract by address, case-insensitively, and accepts others", () => {
    expect(retiredCustodyReason(A("C"), [A("c")])).toMatch(/is retired: its deposits can never be paid out/);
    expect(retiredCustodyReason(A("d"), [A("c")])).toBeNull();
    expect(retiredCustodyReason(A("d"), [])).toBeNull();
    expect(() => retiredCustodyReason(A("d"), ["0x12"])).toThrow();
  });
});
