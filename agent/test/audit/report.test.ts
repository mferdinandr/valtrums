// FIXTURE-ONLY: reports are built from synthetic evidence.
import { describe, expect, it } from "vitest";
import { evaluateCommunity } from "../../src/audit/decision.js";
import { AuditReportStore, buildAuditReport, formatAuditReport, fractionToPercent } from "../../src/audit/report.js";
import { resolveReference } from "../../src/audit/reference.js";
import { FIXTURE_RESOLVED, NOW, REF_TOKEN, asset, goplus, lp, refGoplus, registry } from "./fixtures.js";

const OWNER = "0x00000000000000000000000000000000000000cc";

describe("audit report (fixture-only)", () => {
  it("converts fractions to exact percentages", () => {
    expect(fractionToPercent("0.05")).toBe("5");
    expect(fractionToPercent("0.0125")).toBe("1.25");
    expect(fractionToPercent("0")).toBe("0");
    expect(fractionToPercent("1")).toBe("100");
    expect(fractionToPercent("0.5")).toBe("50");
    expect(fractionToPercent("x")).toBeNull();
  });

  it("reports taxes as percentages, admin capabilities with ownership, and policy/expiry", () => {
    const rec = evaluateCommunity({
      asset,
      goplus: goplus({ buy_tax: "0.05", sell_tax: "0.2", is_mintable: "1", owner_address: OWNER }),
      lp: lp("10001"),
      policy: FIXTURE_RESOLVED,
      now: NOW,
    });
    const r = buildAuditReport(rec);
    expect(r.evidenceHash).toBe(rec.evidenceHash);
    expect(r.result).toBe("reject");
    expect(r.policy).toMatchObject({ version: "audit-policy-v1", taxMaxPercent: "5" });
    expect(r.taxes.find((t) => t.field === "buy_tax")).toMatchObject({ percent: "5", withinLimit: true });
    expect(r.taxes.find((t) => t.field === "sell_tax")).toMatchObject({ percent: "20", withinLimit: false });
    expect(r.ownership.renouncedAndUnrecoverable).toBe("no");
    expect(r.adminCapabilities.find((c) => c.field === "is_mintable")).toMatchObject({
      state: "true",
      active: true,
      admissible: false,
    });
    expect(r.adminCapabilities.find((c) => c.field === "transfer_pausable")).toMatchObject({
      active: false,
      admissible: true,
    });
    expect(r.reasons.map((x) => x.code)).toEqual(
      expect.arrayContaining(["tax_above_limit", "admin_privilege_not_renounced"]),
    );
    expect(r.times.ttlSeconds).toBe(600);
  });

  it("shows unknown fields as unknown, never as zero or false", () => {
    const rec = evaluateCommunity({
      asset,
      goplus: goplus({ sell_tax: "", transfer_pausable: undefined }),
      lp: lp("10001"),
      policy: FIXTURE_RESOLVED,
      now: NOW,
    });
    const r = buildAuditReport(rec);
    expect(r.result).toBe("pending");
    expect(r.taxes.find((t) => t.field === "sell_tax")).toMatchObject({ status: "unknown", percent: null });
    expect(r.adminCapabilities.find((c) => c.field === "transfer_pausable")).toMatchObject({
      state: "unknown",
      active: null,
    });
  });

  it("states the reference mapping and that approval attests the mainnet reference token", () => {
    const m = resolveReference(asset, registry);
    if (m.kind !== "mapped") throw new Error("expected mapping");
    const rec = evaluateCommunity({
      asset: { ...asset, reference: m.reference },
      goplus: refGoplus(),
      lp: lp("10001"),
      policy: FIXTURE_RESOLVED,
      now: NOW,
    });
    const r = buildAuditReport(rec);
    expect(r.auditKind).toBe("reference_token");
    expect(r.reference).toMatchObject({ chainId: "4663", token: REF_TOKEN });
    expect(r.attestation).toContain("not the behaviour of the chain 46630 contract");
    const text = formatAuditReport(r);
    expect(text).toContain(`Audit report ${rec.evidenceHash}`);
    expect(text).toContain("Reference mapping: chain 4663");
    expect(text).toContain("buy_tax: 0%");
    expect(text).toContain("Result: PASS");
  });

  it("indexes reports by evidence hash", () => {
    const rec = evaluateCommunity({ asset, goplus: goplus(), lp: lp("10001"), policy: FIXTURE_RESOLVED, now: NOW });
    const store = new AuditReportStore();
    store.put(rec);
    expect(store.get(rec.evidenceHash)?.result).toBe("pass");
    expect(store.get("missing")).toBeUndefined();
  });
});
