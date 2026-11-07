// FIXTURE-ONLY adapter verification. FIXTURE_RESOLVED is not a real policy.
import { describe, expect, it } from "vitest";
import { evaluateCommunity } from "../../src/audit/decision.js";
import { UNRESOLVED_POLICY, type AuditPolicy } from "../../src/audit/policy.js";
import type { LpEvidence } from "../../src/audit/liquidity.js";
import { FIXTURE_RESOLVED, NOW, asset, goplus, lp } from "./fixtures.js";

const run = (g = goplus(), l: LpEvidence | null = lp("10001"), policy: AuditPolicy = FIXTURE_RESOLVED, now = NOW) =>
  evaluateCommunity({ asset, goplus: g, lp: l, policy, now });

describe("audit decision precedence (fixture-only)", () => {
  it("passes only with clear flags, resolved policies, fresh evidence and LP > 10000", () => {
    const r = run();
    expect(r.result).toBe("pass");
    expect(r.expiresAt).not.toBeNull();
  });

  it("never passes under the default unresolved policy, even with clean evidence", () => {
    const r = run(goplus(), lp("10001"), UNRESOLVED_POLICY);
    expect(r.result).toBe("pending");
    const codes = r.reasons.map((x) => x.code);
    expect(codes).toContain("tax_policy_unresolved");
    expect(codes).toContain("admin_policy_unresolved");
    expect(codes).toContain("freshness_policy_unresolved");
  });

  it("critical flags reject", () => {
    for (const f of ["is_honeypot", "cannot_sell_all", "cannot_buy"]) {
      expect(run(goplus({ [f]: "1" })).result).toBe("reject");
    }
  });

  it("critical plus missing field rejects and keeps both findings", () => {
    const r = run(goplus({ is_honeypot: "1", cannot_buy: undefined }));
    expect(r.result).toBe("reject");
    expect(r.reasons.some((x) => x.code === "critical" && x.field === "is_honeypot")).toBe(true);
    expect(r.reasons.some((x) => x.code === "unknown_field" && x.field === "cannot_buy")).toBe(true);
  });

  it("critical rejection holds even under unresolved policy", () => {
    expect(run(goplus({ is_honeypot: "1" }), null, UNRESOLVED_POLICY).result).toBe("reject");
  });

  it("any tax of exactly 1 rejects", () => {
    for (const f of ["buy_tax", "sell_tax", "transfer_tax"]) {
      expect(run(goplus({ [f]: "1" })).result).toBe("reject");
    }
  });

  it("buy 0.05 + empty sell tax under an unresolved policy stays pending", () => {
    const r = run(goplus({ buy_tax: "0.05", sell_tax: "" }), lp("10001"), UNRESOLVED_POLICY);
    expect(r.result).toBe("pending");
    expect(r.goplus.tax.buy_tax).toMatchObject({ kind: "known", fraction: "0.05" });
    expect(r.goplus.tax.sell_tax.kind).toBe("unknown");
  });

  it("absent mandatory flag or malformed tax is pending", () => {
    expect(run(goplus({ is_honeypot: undefined })).result).toBe("pending");
    expect(run(goplus({ sell_tax: "abc" })).result).toBe("pending");
    expect(run(goplus({ transfer_tax: "2" })).result).toBe("pending");
  });

  it("missing privilege or inspection fields (proxy/closed source omissions) are pending", () => {
    expect(run(goplus({ is_proxy: "1", transfer_pausable: undefined })).result).toBe("pending");
    expect(run(goplus({ is_open_source: undefined })).result).toBe("pending");
    expect(run(goplus({ is_open_source: "0", owner_change_balance: undefined })).result).toBe("pending");
  });

  it("renounced ownership does not override a honeypot", () => {
    expect(run(goplus({ owner_address: "", is_honeypot: "1" })).result).toBe("reject");
  });

  it("an active capability with renounced, unrecoverable ownership is admissible", () => {
    expect(run(goplus({ is_mintable: "1" })).result).toBe("pass");
    const zero = "0x0000000000000000000000000000000000000000";
    expect(run(goplus({ is_mintable: "1", owner_address: zero })).result).toBe("pass");
  });

  it("an active capability with non-renounced ownership rejects with a reason code", () => {
    const owner = "0x00000000000000000000000000000000000000cc";
    for (const flag of [
      "is_mintable",
      "transfer_pausable",
      "is_blacklisted",
      "is_whitelisted",
      "owner_change_balance",
      "slippage_modifiable",
      "personal_slippage_modifiable",
    ]) {
      const r = run(goplus({ [flag]: "1", owner_address: owner }));
      expect(r.result).toBe("reject");
      expect(r.reasons).toContainEqual(expect.objectContaining({ code: "admin_privilege_not_renounced", field: flag }));
    }
    expect(run(goplus({ is_mintable: "1", hidden_owner: "1" })).result).toBe("reject");
    expect(run(goplus({ is_mintable: "1", can_take_back_ownership: "1" })).result).toBe("reject");
  });

  it("an active capability with unknown ownership holds pending", () => {
    const r = run(goplus({ is_mintable: "1", hidden_owner: undefined }));
    expect(r.result).toBe("pending");
    expect(r.reasons.some((x) => x.code === "ownership_unknown")).toBe(true);
  });

  it("inactive capabilities do not need renounced ownership", () => {
    const owner = "0x00000000000000000000000000000000000000cc";
    expect(run(goplus({ owner_address: owner })).result).toBe("pass");
  });

  it("tax up to and including 0.05 is admissible; above rejects with tax_above_limit; exactly 1 rejects", () => {
    expect(run(goplus({ buy_tax: "0.05", sell_tax: "0.050", transfer_tax: "0.01" })).result).toBe("pass");
    for (const f of ["buy_tax", "sell_tax", "transfer_tax"]) {
      const r = run(goplus({ [f]: "0.050000001" }));
      expect(r.result).toBe("reject");
      expect(r.reasons).toContainEqual(expect.objectContaining({ code: "tax_above_limit", field: f }));
      expect(run(goplus({ [f]: "1" })).result).toBe("reject");
    }
  });

  it("tax above the limit plus an unknown field rejects and keeps the unknown finding", () => {
    const r = run(goplus({ buy_tax: "0.2", sell_tax: "" }));
    expect(r.result).toBe("reject");
    expect(r.reasons.some((x) => x.code === "unknown_field" && x.field === "sell_tax")).toBe(true);
  });

  it("policy hash reflects the resolved decisions and their parameters", () => {
    const a = run().policyHash;
    const capped = { ...FIXTURE_RESOLVED, tax: { status: "resolved", id: "tax-cap-v1", maxFraction: "0.06" } } as const;
    expect(run(goplus(), lp("10001"), capped).policyHash).not.toBe(a);
    expect(run(goplus(), lp("10001"), { ...FIXTURE_RESOLVED, tax: { status: "unresolved" } }).policyHash).not.toBe(a);
    expect(run().policyVersion).toBe("audit-policy-v1");
    // The LP valuation label is committed: evidence carrying another source cannot pass.
    expect(run(goplus(), lp("50000", { valuationSource: "executable_depth" })).result).toBe("pending");
  });

  it("wrong chain/token or unsupported coverage cannot approve or reject", () => {
    const wrongKey = run(goplus({ is_honeypot: "1" }, { key: "0x00000000000000000000000000000000000000bb" }));
    expect(wrongKey.result).toBe("pending");
    const wrongChain = run(goplus({}, { chainId: "4663" }));
    expect(wrongChain.result).toBe("pending");
    expect(run(goplus({}, { code: 2022, result: null })).result).toBe("pending");
  });

  it("GoPlus clean but LP absent is pending; LP at 10000 withholds approval", () => {
    expect(run(goplus(), null).result).toBe("pending");
    const eq = run(goplus(), lp("10000"));
    expect(eq.result).toBe("pending");
    expect(eq.reasons.some((x) => x.code === "lp_at_or_below_threshold")).toBe(true);
    expect(run(goplus(), lp("9999")).result).toBe("pending");
  });

  it("stale evidence does not approve", () => {
    const late = new Date(NOW.getTime() + 60 * 60_000);
    const r = run(goplus(), lp("10001"), FIXTURE_RESOLVED, late);
    expect(r.result).toBe("pending");
    expect(r.reasons.some((x) => x.code === "stale_evidence")).toBe(true);
  });

  it("stale LP observation alone does not approve", () => {
    const r = run(goplus(), lp("10001", { observedAt: "2026-11-07T09:00:00.000Z" }));
    expect(r.result).toBe("pending");
  });

  it("future-dated evidence does not approve", () => {
    const early = new Date("2026-11-07T11:00:00.000Z");
    expect(run(goplus(), lp("10001"), FIXTURE_RESOLVED, early).result).toBe("pending");
  });

  it("evidence hash and policy hash change with policy and evidence", () => {
    const a = run();
    const b = run(goplus({ buy_tax: "0" }, {}), lp("10002"));
    expect(a.evidenceHash).not.toBe(b.evidenceHash);
    expect(a.policyHash).not.toBe(run(goplus(), lp("10001"), UNRESOLVED_POLICY).policyHash);
    expect(a.rawResponseHash).toHaveLength(64);
  });
});
