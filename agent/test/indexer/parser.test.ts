// FIXTURE-ONLY: synthetic NEP-297 logs; no network or live provider.
import { describe, expect, it } from "vitest";
import { losslessParse, parseBlock } from "../../src/indexer/parser.js";
import { CONTRACT, auditUpdated, block, config, created, deposit, emitLog, emitRaw, outcome } from "./fixtures.js";

describe("losslessParse", () => {
  it("keeps large integers exact and flags non-integer numbers", () => {
    const v = losslessParse('{"big": 12345678901234567890, "small": 3, "frac": 1.5}') as Record<string, unknown>;
    expect(v.big).toBe(12345678901234567890n);
    expect(v.small).toBe(3n);
    expect(v.frac).toEqual({ __unsafeNumber: "1.5" });
  });
});

describe("parseBlock accepts current supported events", () => {
  it("parses created, audit and deposit with stable identities and provenance", () => {
    const b = block({
      height: "10",
      outcomes: [
        outcome("r1", [created(1, "alice.testnet")]),
        outcome("r2", [auditUpdated(1, 0, "pass"), deposit(1, 0, "bob.testnet", "1000")]),
      ],
    });
    const { accepted, diagnostics } = parseBlock(b, config());
    expect(diagnostics).toHaveLength(0);
    expect(accepted.map((e) => e.name)).toEqual(["lifecycle_battle_created", "audit_updated", "lifecycle_deposit"]);
    expect(new Set(accepted.map((e) => e.dedupKey)).size).toBe(3);
    const created1 = accepted[0]!;
    expect(created1.provenance).toMatchObject({ contract: CONTRACT, blockHeight: "10", receiptId: "r1", logIndex: 0, itemIndex: 0 });
    if (created1.name === "lifecycle_battle_created") expect(created1).toMatchObject({ battleId: "1", creator: "alice.testnet" });
    const dep = accepted[2]!;
    if (dep.name === "lifecycle_deposit") expect(dep).toMatchObject({ battleId: "1", community: "0", accountId: "bob.testnet", amount: "1000" });
  });

  it("preserves a u64 battle id beyond Number.MAX_SAFE_INTEGER exactly", () => {
    const b = block({ height: "1", outcomes: [outcome("r1", [emitRaw("lifecycle_battle_created", '{"battle_id":12345678901234567890,"creator":"a.testnet"}')])] });
    const { accepted } = parseBlock(b, config());
    expect(accepted).toHaveLength(1);
    const e = accepted[0]!;
    if (e.name === "lifecycle_battle_created") expect(e.battleId).toBe("12345678901234567890");
  });
});

describe("parseBlock quarantines bad input without applying it", () => {
  const parse1 = (log: string, over = {}) =>
    parseBlock(block({ height: "1", outcomes: [outcome("r1", [log], over)] }), config());

  it("rejects a wrong emitter", () => {
    const { accepted, diagnostics } = parse1(created(1), { executorId: "evil.testnet" });
    expect(accepted).toHaveLength(0);
    expect(diagnostics[0]!.reason).toBe("wrong_emitter");
  });

  it("rejects a failed outcome", () => {
    const { accepted, diagnostics } = parse1(created(1), { success: false });
    expect(accepted).toHaveLength(0);
    expect(diagnostics[0]!.reason).toBe("failed_outcome");
  });

  it("rejects an unsafe numeric amount but keeps the raw for diagnosis", () => {
    const { accepted, diagnostics } = parse1(emitRaw("lifecycle_deposit", '{"battle_id":1,"community":0,"account_id":"b.testnet","amount":1.5}'));
    expect(accepted).toHaveLength(0);
    expect(diagnostics[0]!.reason).toBe("unsafe_numeric"); // 1.5 is a non-integer number
    expect(diagnostics[0]!.rawLog).toContain("1.5");
  });

  it("flags unknown event and unsupported version distinctly", () => {
    expect(parse1(emitLog("mystery_event", { x: 1 })).diagnostics[0]!.reason).toBe("unknown_event");
    expect(parse1(emitLog("lifecycle_deposit", {}, { version: "9.9.9" })).diagnostics[0]!.reason).toBe("unsupported_version");
  });

  it("ignores unrelated and other-standard logs", () => {
    expect(parse1("some plain log line").diagnostics).toHaveLength(0);
    expect(parse1("some plain log line").accepted).toHaveLength(0);
    expect(parse1(emitLog("lifecycle_deposit", { battle_id: 1, community: 0, account_id: "b.testnet", amount: "1" }, { standard: "nep171" })).diagnostics).toHaveLength(0);
  });

  it("quarantines a malformed supported payload", () => {
    const { accepted, diagnostics } = parse1(emitLog("audit_updated", { battle_id: 1, community: 0, result: "maybe", evidence_hash: "x" }));
    expect(accepted).toHaveLength(0);
    expect(diagnostics[0]!.reason).toBe("malformed_payload");
  });

  it("detects a conflicting payload under the same identity via the digest", () => {
    const a = parse1(created(1, "alice.testnet")).accepted[0]!;
    const b = parse1(created(1, "mallory.testnet")).accepted[0]!;
    expect(a.dedupKey).toBe(b.dedupKey);
    expect(a.payloadDigest).not.toBe(b.payloadDigest);
  });
});
