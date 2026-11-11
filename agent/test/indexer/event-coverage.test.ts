// FIXTURE-ONLY: payload shapes copied from the contract emitters on main (arena lifecycle_backing.rs,
// backing lib.rs, payout contract.rs); no live chain. Not live evidence.
import { describe, expect, it } from "vitest";
import { parseBlock } from "../../src/indexer/parser.js";
import { buildProjection } from "../../src/indexer/projection.js";
import { block, config, emitLog, emitObject, outcome } from "./fixtures.js";

const reqId = Array.from({ length: 32 }, (_, i) => i);
const reqHex = reqId.map((b) => b.toString(16).padStart(2, "0")).join("");
const hash64 = "ab".repeat(32);

const parse = (log: string) => parseBlock(block({ height: "7", outcomes: [outcome("r1", [log])] }), config());

describe("modelled events from the arena, backing and payout standards", () => {
  const cases: [string, string][] = [
    ["backing_updated", emitLog("backing_updated", { battle_id: 3, community: 1, approved: true, evidence_hash: "e".repeat(64), expires_at_ms: "1799999999000" })],
    ["backing_updated", emitLog("backing_updated", { battle_id: 3, community: 1, approved: false, evidence_hash: null, expires_at_ms: null })],
    ["lifecycle_representation_trust_changed", emitLog("lifecycle_representation_trust_changed", { representation: "rep.testnet", trusted: true })],
    ["late_deposit_recorded", emitObject("valtrum_backing", "late_deposit_recorded", { battle_id: "3", beneficiary: "bob.testnet", refund_address: `0x${"11".repeat(20)}`, units: "500" })],
    ["asset_suspended", emitObject("valtrum_backing", "asset_suspended", { reason: "reorg" })],
    ["asset_resumed", emitObject("valtrum_backing", "asset_resumed", { by: "owner.testnet", reorg: true, deficit: false, still_suspended: false })],
    ["custody_attested", emitObject("valtrum_backing", "custody_attested", { sequence: "1", source_block_number: 99, balance: "1000", required: "900", covered: true })],
    ["custody_attested", emitObject("valtrum_backing", "custody_attested", { sequence: "2", source_block_number: 100, balance: "10", required: null, covered: false })],
    ["reconciliation_unresolved", emitObject("valtrum_backing", "reconciliation_unresolved", { holder: "bob.testnet", request_id: reqId })],
    ["operator_changed", emitObject("valtrum_backing", "operator_changed", { old: null, new: "op.testnet", by: "owner.testnet" })],
    ["resume_policy_changed", emitObject("valtrum_backing", "resume_policy_changed", { old: "OwnerWithEvidence", new: "Disabled", by: "owner.testnet" })],
    ["payout_signature_requested", emitObject("valtrum_payout", "signature_requested", { backing: "b.testnet", holder: "bob.testnet", request_id: reqHex, payload_hash: hash64, max_fee_per_gas: "1000", nonce: 4 })],
    ["payout_signature_received", emitObject("valtrum_payout", "signature_received", { backing: "b.testnet", holder: "bob.testnet", request_id: reqHex, tx_hash: hash64, max_fee_per_gas: "1000" })],
    ["payout_signature_failed", emitObject("valtrum_payout", "signature_failed", { backing: "b.testnet", holder: "bob.testnet", request_id: reqHex, max_fee_per_gas: "1000" })],
    ["payout_state_changed", emitObject("valtrum_payout", "payout_state_changed", { backing: "b.testnet", holder: "bob.testnet", request_id: reqHex, from: null, to: "signing", reason: null })],
  ];
  it.each(cases)("accepts %s", (name, log) => {
    const { accepted, diagnostics } = parse(log);
    expect(diagnostics).toEqual([]);
    expect(accepted.map((e) => e.name)).toEqual([name]);
  });

  it("projects late deposits with their refund address and contract-level state", () => {
    const logs = [
      emitObject("valtrum_backing", "late_deposit_recorded", { battle_id: "3", beneficiary: "bob.testnet", refund_address: `0x${"11".repeat(20)}`, units: "500" }),
      emitObject("valtrum_backing", "asset_suspended", { reason: "reorg" }),
      emitLog("backing_updated", { battle_id: 3, community: 1, approved: true, evidence_hash: "e".repeat(64), expires_at_ms: "5" }),
      emitObject("valtrum_payout", "payout_state_changed", { backing: "b.testnet", holder: "bob.testnet", request_id: reqHex, from: null, to: "signing", reason: null }),
    ];
    const { accepted } = parseBlock(block({ height: "7", outcomes: logs.map((l, i) => outcome(`r${i}`, [l])) }), config());
    const proj = buildProjection(accepted, { finalizedHeight: 7n, reducerVersion: "projection-v1" });
    const battles = Object.values(proj.battles);
    expect(battles.flatMap((b) => b.lateDeposits).map((d) => d.refundAddress)).toEqual([`0x${"11".repeat(20)}`]);
    expect(battles.find((b) => b.backings["1"])?.backings["1"]?.approved).toBe(true);
    const c = Object.values(proj.contracts)[0]!;
    expect(c.suspension).toMatchObject({ suspended: true, reasons: ["reorg"] });
    expect(Object.values(c.payouts)[0]).toMatchObject({ state: "signing" });
  });
});

describe("no event emitted on main is silently dropped", () => {
  // Inventory of every wire event name on main (from the contract emitters) that is NOT modelled. Each
  // must surface as `unknown_event`, a degrading diagnostic, never be dropped.
  const unsupported: Record<string, string[]> = {
    valtrum: [
      "battle_proposed", "battle_approved", "battle_locked", "battle_settling", "battle_settled", "battle_voided", "balance_funded",
      "deposit", "claim", "refund", "deposit_usdc_refunded", "emergency_halt", "execution_reported", "signature_requested",
      "signature_ready", "signature_failed", "step_dispatch_failed", "withdraw_failed", "treasury_flushed", "treasury_flush_failed",
      "dao_vote_cast", "dao_disposition_released", "principal_escrowed", "reference_registry_updated", "burned", "burn_failed",
      // Open-arena events the contract emits that the indexer does not model yet (still reported, never dropped).
      "lifecycle_refund_failed", "lifecycle_joinable_asset_set", "lifecycle_joinable_asset_removed",
    ],
    valtrum_player_policy: ["grant_created", "grant_revoked", "budget_reserved"],
  };

  for (const [standard, events] of Object.entries(unsupported)) {
    it.each(events)(`reports unmodelled ${standard}/%s as unknown_event`, (event) => {
      const log = standard === "valtrum" ? emitLog(event, { battle_id: 1 }) : emitObject(standard, event, [{}]);
      const { accepted, diagnostics } = parse(log);
      expect(accepted).toEqual([]);
      expect(diagnostics.map((d) => d.reason)).toEqual(["unknown_event"]);
    });
  }

  it("quarantines a companion event with an unreadable payload instead of dropping it", () => {
    const { accepted, diagnostics } = parse(emitObject("valtrum_backing", "late_deposit_recorded", { battle_id: "3" }));
    expect(accepted).toEqual([]);
    expect(diagnostics.map((d) => d.reason)).toEqual(["malformed_payload"]);
  });

  it("ignores an unrelated standard, and a foreign emitter's companion log is not allowlisted state", () => {
    expect(parse(emitObject("war", "anything", {})).diagnostics).toEqual([]);
    const foreign = parseBlock(
      block({ height: "7", outcomes: [outcome("r1", [emitObject("valtrum_backing", "asset_suspended", { reason: "x" })], { executorId: "evil.testnet" })] }),
      config(),
    );
    expect(foreign.diagnostics.map((d) => d.reason)).toEqual(["wrong_emitter"]);
  });
});
