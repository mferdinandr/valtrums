import { describe, expect, it } from "vitest";
import type { PayoutAttemptState, PayoutState, PayoutView } from "../src/payout-status.js";
import {
  buildTokenSettlementStates,
  readSettlementStates,
  type ViewCaller,
} from "../src/settlement-states.js";

// All values below are FIXTURES shaped like the contract views; they are not live evidence.
const HOLDER = "alice.testnet";
const B = "backing-b.testnet";
const C = "backing-c.testnet";

function payout(
  backing: string,
  request: number,
  state: PayoutState,
  amount: string,
  attempts: PayoutAttemptState[] = [],
): PayoutView {
  return {
    backing,
    holder: HOLDER,
    request_id: Array(32).fill(request),
    state,
    reason: state === "reconciliation_required" ? "BroadcastUnconfirmed" : null,
    terminal: state === "confirmed" || state === "restored",
    chain_id: "46630",
    token: Array(20).fill(1),
    sender: Array(20).fill(2),
    destination: Array(20).fill(3),
    amount,
    path: "p",
    nonce: "0",
    binding_hash: Array(32).fill(9),
    attempts: attempts.map((s) => ({ tx_hash: Array(32).fill(7), max_fee_per_gas: "1", state: s })),
    evidence_hash: state === "confirmed" ? Array(32).fill(5) : null,
  };
}

const base = { holder: HOLDER, sourceDecimals: 18, representationDecimals: 18 };

describe("per-token settlement states", () => {
  it("keeps B confirmed while C is pending, each balanced to its own entitlement", () => {
    const b = buildTokenSettlementStates({
      ...base, backing: B, entitled: 100n, available: 40n,
      payouts: [payout(B, 1, "confirmed", "60", ["broadcast"])],
    });
    const c = buildTokenSettlementStates({
      ...base, backing: C, entitled: 100n, available: 40n,
      payouts: [payout(C, 1, "pending_finality", "60", ["pending"])],
    });
    expect([b.confirmed, b.confirmationPending, b.balanced]).toEqual([60n, 0n, true]);
    expect([c.confirmed, c.confirmationPending, c.balanced]).toEqual([0n, 60n, true]);
    expect(c.openRequests).toHaveLength(1);
    expect(b.openRequests).toHaveLength(0);
  });

  it("never counts a signature or a broadcast hash as paid", () => {
    const states: PayoutState[] = ["authorized", "signing_requested", "signed", "broadcast", "pending_finality", "reverted", "reconciliation_required"];
    for (const s of states) {
      const r = buildTokenSettlementStates({
        ...base, backing: B, entitled: 100n, available: 0n,
        payouts: [payout(B, 1, s, "100", ["signed", "broadcast"])],
      });
      expect(r.confirmed).toBe(0n);
      expect(r.balanced).toBe(true);
    }
    const sig = buildTokenSettlementStates({ ...base, backing: B, entitled: 10n, available: 0n, payouts: [payout(B, 1, "signed", "10", ["signed"])] });
    expect(sig.reserved).toBe(10n);
    const bc = buildTokenSettlementStates({ ...base, backing: B, entitled: 10n, available: 0n, payouts: [payout(B, 1, "broadcast", "10", ["broadcast"])] });
    expect(bc.broadcast).toBe(10n);
  });

  it("holds a reconciliation case as pending only when a spend may have happened", () => {
    const spent = buildTokenSettlementStates({ ...base, backing: B, entitled: 5n, available: 0n, payouts: [payout(B, 1, "reconciliation_required", "5", ["broadcast"])] });
    const unsigned = buildTokenSettlementStates({ ...base, backing: B, entitled: 5n, available: 0n, payouts: [payout(B, 1, "reconciliation_required", "5", ["requested"])] });
    expect(spent.confirmationPending).toBe(5n);
    expect(unsigned.reserved).toBe(5n);
  });

  it("leaves rewards payable while principal disposition is unresolved", () => {
    // The model takes no DAO input at all: payability depends only on the entitlement.
    const r = buildTokenSettlementStates({ ...base, backing: B, entitled: 100n, available: 100n, payouts: [] });
    expect(r.payable).toBe(true);
    expect(r.balanced).toBe(true);
  });

  it("returns a restored payout to available without counting it twice", () => {
    const r = buildTokenSettlementStates({ ...base, backing: B, entitled: 100n, available: 100n, payouts: [payout(B, 1, "restored", "60")] });
    expect([r.available, r.reserved, r.balanced]).toEqual([100n, 0n, true]);
  });

  it("flags an imbalance instead of hiding it", () => {
    const r = buildTokenSettlementStates({ ...base, backing: B, entitled: 100n, available: 30n, payouts: [payout(B, 1, "signed", "60")] });
    expect(r.balanced).toBe(false);
  });

  it("converts source payout units into representation units", () => {
    const r = buildTokenSettlementStates({
      holder: HOLDER, backing: B, entitled: 100_000_000n, available: 0n,
      sourceDecimals: 6, representationDecimals: 8,
      payouts: [payout(B, 1, "confirmed", "1000000")],
    });
    expect(r.confirmed).toBe(100_000_000n);
    expect(r.balanced).toBe(true);
  });

  it("rejects another holder's payout and conflicting duplicates", () => {
    const other = { ...payout(B, 1, "signed", "1"), holder: "bob.testnet" };
    expect(() => buildTokenSettlementStates({ ...base, backing: B, entitled: 1n, available: 0n, payouts: [other] })).toThrow();
    expect(() => buildTokenSettlementStates({
      ...base, backing: B, entitled: 1n, available: 0n,
      payouts: [payout(B, 1, "signed", "1"), payout(B, 1, "signed", "2")],
    })).toThrow(/conflicting/);
  });
});

/** Fixture view transport: two backings plus a payout contract, with a switchable failure. */
function fixtureCaller(failBacking?: string): { caller: ViewCaller; calls: string[] } {
  const calls: string[] = [];
  const allocations: Record<string, { beneficiary: string; amount: string }> = {
    [`${B}:1`]: { beneficiary: HOLDER, amount: "100" },
    [`${C}:2`]: { beneficiary: HOLDER, amount: "100" },
  };
  const available: Record<string, string> = { [B]: "40", [C]: "40" };
  const payouts: Record<string, PayoutView> = {
    [`${B}:9`]: payout(B, 9, "confirmed", "60", ["broadcast"]),
    [`${C}:9`]: payout(C, 9, "broadcast", "60", ["broadcast"]),
  };
  return {
    calls,
    caller: {
      async view<T>(contract: string, method: string, args: object) {
        calls.push(`${contract}.${method}`);
        const a = args as Record<string, any>;
        if (contract === failBacking) throw new Error("rpc down");
        if (method === "get_allocation") return (allocations[`${contract}:${a.allocation_id[0]}`] ?? null) as T | null;
        if (method === "entitlement_of") return available[contract] as T;
        if (method === "get_payout") return (payouts[`${a.backing}:${a.request_id[0]}`] ?? null) as T | null;
        return null;
      },
    },
  };
}

describe("reading states from views", () => {
  const queries = [
    { backing: B, holder: HOLDER, allocationIds: [Array(32).fill(1)], requestIds: [Array(32).fill(9)], sourceDecimals: 18, representationDecimals: 18 },
    { backing: C, holder: HOLDER, allocationIds: [Array(32).fill(2)], requestIds: [Array(32).fill(9)], sourceDecimals: 18, representationDecimals: 18 },
  ];

  it("progresses tokens independently and survives one backing failing", async () => {
    const ok = await readSettlementStates(fixtureCaller().caller, "payout.testnet", queries);
    expect(ok[0]?.states?.confirmed).toBe(60n);
    expect(ok[1]?.states?.broadcast).toBe(60n);
    expect(ok.every((r) => r.states?.balanced)).toBe(true);

    const partial = await readSettlementStates(fixtureCaller(C).caller, "payout.testnet", queries);
    expect(partial[0]?.states?.confirmed).toBe(60n);
    expect(partial[1]?.error).toMatch(/rpc down/);
  });

  it("is unchanged by a lost-response retry: same ids, no repeated allocation or fee", async () => {
    const dup = queries.map((q) => ({
      ...q,
      // The retried request and allocation ids appear twice, as after a lost response.
      allocationIds: [...q.allocationIds, ...q.allocationIds],
      requestIds: [...q.requestIds, ...q.requestIds],
    }));
    const once = await readSettlementStates(fixtureCaller().caller, "payout.testnet", queries);
    const retried = await readSettlementStates(fixtureCaller().caller, "payout.testnet", dup);
    expect(retried).toEqual(once);
    expect(retried[0]?.states?.entitled).toBe(100n);
  });

  it("rejects an allocation that belongs to another holder", async () => {
    const r = await readSettlementStates(fixtureCaller().caller, "payout.testnet", [{ ...queries[0]!, holder: "bob.testnet" }]);
    expect(r[0]?.error).toMatch(/another holder/);
  });
});
