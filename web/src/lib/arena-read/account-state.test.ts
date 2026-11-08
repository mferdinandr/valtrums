// FIXTURE-ONLY: synthetic account state; not observed on any network.
import { describe, expect, it } from "vitest";
import { type AccountStateData, describeAccountState, orderAlerts, provenance } from "./account-state";

const NOW = Date.parse("2026-11-09T10:00:00.000Z");
const live = { source: { kind: "live" as const, name: "arena.testnet" }, observedAt: "2026-11-09T09:59:30.000Z" };

const data = (over: Partial<AccountStateData> = {}): AccountStateData => ({
  accountId: "alice.testnet",
  entitlements: [{ ...live, backing: "pepe.rep.testnet", available: "40" }],
  transfers: [
    { ...live, backing: "pepe.rep.testnet", amount: "9", state: "Signed", displayState: "reserved", label: "Reserved: set aside for this payout, not sent" },
    { ...live, backing: "pepe.rep.testnet", amount: "5", state: "Broadcast", displayState: "broadcast", label: "Broadcast: sent to the network, not confirmed" },
    { ...live, backing: "pepe.rep.testnet", amount: "3", state: "Confirmed", displayState: "confirmed", label: "Confirmed" },
  ],
  daoPrincipal: [
    {
      ...live,
      battleId: 2,
      community: 0,
      position: "60",
      voteStatus: "decided",
      voteClosesAtNs: "1",
      myReturn: { amount: "24", recorded: true },
      escrow: { escrowed: "100", returned: "40", burn_pending: "60", burn_confirmed: "0", still_escrowed: "0" },
    },
  ],
  ...over,
});

describe("account state display", () => {
  it("shows entitlement, each transfer stage and DAO principal in separate sections", () => {
    const view = describeAccountState(data(), NOW);
    expect(view.entitlements[0]).toMatchObject({ status: "Entitlement available", detail: expect.stringMatching(/nothing has been transferred/) });
    expect(view.transfers.map((t) => t.status)).toEqual([
      "Reserved: set aside for this payout, not sent",
      "Broadcast: sent to the network, not confirmed",
      "Paid (confirmed)",
    ]);
    expect(view.transfers[1]!.detail).toBe("not paid until its receipt is confirmed");
    expect(view.dao[0]).toMatchObject({ status: "Decided" });
    expect(view.dao[0]!.detail).toContain("burn confirmed 0, burn pending 60");
    expect(view.dao[0]!.detail).toContain("your return 24 (entitlement recorded)");
  });

  it("labels each vote state and keeps undecided principal escrowed", () => {
    const states: Record<string, string> = {
      no_vote: "No vote for this battle: principal stays escrowed",
      voting: "Vote open",
      undecided_escrowed: "Vote closed without votes: principal stays escrowed",
      unknown: "Vote status unavailable",
    };
    for (const [voteStatus, label] of Object.entries(states)) {
      const d = data({ daoPrincipal: [{ ...data().daoPrincipal[0]!, voteStatus, myReturn: null, escrow: null }] });
      expect(describeAccountState(d, NOW).dao[0]!.status).toBe(label);
    }
  });

  it("names source and freshness, and flags fixtures and stale data", () => {
    expect(provenance(live, NOW)).toBe("live · arena.testnet · observed 2026-11-09T09:59:30.000Z · fresh");
    expect(provenance({ ...live, observedAt: "2026-11-09T09:00:00.000Z" }, NOW)).toMatch(/stale$/);
    expect(provenance({ ...live, source: { kind: "fixture", name: "f" } }, NOW)).toMatch(/^FIXTURE \(not live\)/);
    expect(provenance({ ...live, observedAt: "bad" }, NOW)).toMatch(/freshness unknown$/);
  });

  it("orders alerts critical first, stably", () => {
    const ordered = orderAlerts([
      { id: "b", kind: "indexer_stale", severity: "warning", subject: "indexer", message: "" },
      { id: "c", kind: "payout_unresolved", severity: "critical", subject: "p", message: "" },
      { id: "a", kind: "backing_deficit", severity: "critical", subject: "x", message: "" },
    ]);
    expect(ordered.map((a) => a.id)).toEqual(["a", "c", "b"]);
  });
});
