// FIXTURE EVIDENCE: the recorded trace of a funded quote through the fixture to a confirmed arena deposit.
// Not live evidence. Regenerate the committed file with UPDATE_TRACE=1.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIXTURE_LABEL } from "../../src/intents-fixture/label.js";
import { runFundedTrace } from "./trace.js";

const TRACE_PATH = fileURLToPath(new URL("../../../docs/evidence/2026-11-09-intents-fixture-trace.json", import.meta.url));

describe("funded quote trace through the fixture", () => {
  it("binds the action, preview, authorization, route status and custody receipt, and matches the committed trace", async () => {
    const trace = await runFundedTrace("complete");
    expect(trace.finalRouteStatus).toBe("SUCCESS");
    expect(trace.routeStatuses).toEqual(["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"]);
    expect(trace.custodyReceipt).toMatchObject({ kind: "delivery", chainId: "46630", amount: "9904355", to: "0x2222222222222222222222222222222222222222" });
    expect(trace.credit.first).toEqual({ credited: true });
    expect(trace.credit.replay).toEqual({ credited: false, reason: "receipt already credited" });
    expect(trace.actionStatuses).toEqual(["previewed", "authorized", "ready_to_sign", "broadcast", "confirmed"]);
    expect(trace.action).toMatchObject({
      kind: "deposit",
      amount: "9904355",
      finalStatus: "confirmed",
      authorization: { kind: "user_signature", accountId: "alice.testnet" },
      route: { name: "intents-fixture", fixture: true, label: FIXTURE_LABEL },
      limitationsLabelled: true,
    });
    expect(trace.bindingDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(trace.label).toMatch(/^FIXTURE EVIDENCE/);
    if (process.env.UPDATE_TRACE === "1") writeFileSync(TRACE_PATH, `${JSON.stringify(trace, null, 2)}\n`);
    expect(JSON.parse(JSON.stringify(trace))).toEqual(JSON.parse(readFileSync(TRACE_PATH, "utf8")));
  });

  it("a failing solver leaves no custody receipt, no credit and no action", async () => {
    const trace = await runFundedTrace("fail");
    expect(trace.finalRouteStatus).toBe("FAILED");
    expect(trace.custodyReceipt).toBeNull();
    expect(trace.credit.creditedAmount).toBe("0");
    expect(trace.action).toBeNull();
    expect(trace.actionStatuses).toEqual([]);
  });

  it("a refunding solver refunds the origin token, credits nothing and starts no action", async () => {
    const trace = await runFundedTrace("refund");
    expect(trace.finalRouteStatus).toBe("REFUNDED");
    expect(trace.custodyReceipt).toMatchObject({ kind: "refund", to: "alice.testnet", amount: "10000000" });
    expect(trace.credit.first).toEqual({ credited: false, reason: "only a delivery receipt credits" });
    expect(trace.credit.creditedAmount).toBe("0");
    expect(trace.action).toBeNull();
  });
});
