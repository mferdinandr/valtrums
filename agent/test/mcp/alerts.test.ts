// FIXTURE-ONLY: battles, backings, payouts, disposition and indexer health are synthetic.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FixtureStateSource, NearStateSource, buildAccountState } from "../../src/mcp/account-state.js";
import { type AlertInput, evaluateAlerts } from "../../src/mcp/alerts.js";
import { FixtureArenaReadSource, type PayoutView } from "../../src/mcp/read-source.js";
import { callReadTool } from "../../src/mcp/tools.js";
import { NOW, battle, makeSessions, signRead } from "./fixtures.js";

const approved = (over = {}) => {
  const b = battle(over);
  b.communities = b.communities.map((c) => ({ ...c, audit_evidence_hash: "a", audit_expires_at_ms: String(NOW + 60_000), backing_evidence_hash: "b" }));
  return b;
};
const payout = (state: PayoutView["state"], holder = "alice.testnet"): PayoutView => ({
  backing: "pepe.rep.testnet",
  holder,
  request_id: [1, 2, 3],
  state,
  terminal: state === "Confirmed" || state === "Restored",
  chain_id: "46630",
  amount: "9",
  attempts: [],
  evidence_hash: null,
});
const healthy: AlertInput = {
  nowMs: NOW,
  battles: [{ battleId: 1, battle: approved(), round: null }],
  backings: [{ backing: "pepe.rep.testnet", suspension: { suspended: false, reorg: false, deficit: false, unresolved: "0" }, ledger: { accounting_balanced: true, reconciliation_required: false } }],
  payouts: [payout("Broadcast")],
  indexer: { status: "healthy", reason: "ok", lastSyncMs: NOW - 1_000 },
};
const kinds = (input: AlertInput) => evaluateAlerts(input).map((a) => a.kind);

describe("recovery alerts fire on each condition and clear when it is resolved", () => {
  it("is quiet when everything is healthy (a broadcast payout is not an alert)", () => {
    expect(evaluateAlerts(healthy)).toEqual([]);
  });

  it("missing or expired audit data", () => {
    const missing = battle();
    expect(kinds({ ...healthy, battles: [{ battleId: 1, battle: missing, round: null }] })).toEqual(["audit_missing", "audit_missing"]);
    const expired = approved();
    expired.communities[0]!.audit_expires_at_ms = String(NOW - 1);
    expect(kinds({ ...healthy, battles: [{ battleId: 1, battle: expired, round: null }] })).toEqual(["audit_expired"]);
    // A locked battle no longer needs a fresh audit.
    expect(kinds({ ...healthy, battles: [{ battleId: 1, battle: { ...missing, locked: true }, round: null }] })).toEqual([]);
  });

  it("missing market data: a round past its end without a winner, after the grace period", () => {
    const locked = approved({ locked: true });
    const endNs = String(BigInt(NOW - 10 * 60_000) * 1_000_000n);
    const round = { round_id: "3", candidates: [0, 1], start_ns: "1", end_ns: endNs, winner: null };
    expect(kinds({ ...healthy, battles: [{ battleId: 1, battle: locked, round }] })).toEqual(["market_data_missing"]);
    expect(kinds({ ...healthy, battles: [{ battleId: 1, battle: locked, round: { ...round, winner: 0 } }] })).toEqual([]);
    const recent = String(BigInt(NOW - 60_000) * 1_000_000n);
    expect(kinds({ ...healthy, battles: [{ battleId: 1, battle: locked, round: { ...round, end_ns: recent } }] })).toEqual([]);
  });

  it("backing deficits, suspension and unbalanced accounting", () => {
    const backing = healthy.backings[0]!;
    const deficit = { ...backing, suspension: { ...backing.suspension!, suspended: true, deficit: true } };
    expect(kinds({ ...healthy, backings: [deficit] })).toEqual(["backing_deficit"]);
    const reorg = { ...backing, suspension: { ...backing.suspension!, reorg: true } };
    expect(kinds({ ...healthy, backings: [reorg] })).toEqual(["backing_suspended"]);
    const unbalanced = { ...backing, ledger: { accounting_balanced: false, reconciliation_required: false } };
    expect(kinds({ ...healthy, backings: [unbalanced] })).toEqual(["accounting_unbalanced"]);
  });

  it("unresolved payouts", () => {
    expect(kinds({ ...healthy, payouts: [payout("ReconciliationRequired")] })).toEqual(["payout_unresolved"]);
    expect(kinds({ ...healthy, payouts: [payout("Reverted")] })).toEqual(["payout_unresolved"]);
    expect(kinds({ ...healthy, payouts: [payout("Confirmed")] })).toEqual([]);
  });

  it("indexer reconciliation, degradation and staleness", () => {
    expect(kinds({ ...healthy, indexer: { status: "reconciliation_required", reason: "fork below finality", lastSyncMs: NOW } })).toEqual(["indexer_reconciliation"]);
    expect(kinds({ ...healthy, indexer: { status: "degraded", reason: "coverage gap", lastSyncMs: NOW } })).toEqual(["indexer_degraded"]);
    expect(kinds({ ...healthy, indexer: { status: "healthy", reason: "ok", lastSyncMs: NOW - 3_600_000 } })).toEqual(["indexer_stale"]);
    expect(kinds({ ...healthy, indexer: { status: "healthy", reason: "ok", lastSyncMs: null } })).toEqual(["indexer_stale"]);
  });

  it("ids are stable per subject so a UI can track an alert until it clears", () => {
    const a = evaluateAlerts({ ...healthy, payouts: [payout("Reverted")] });
    const b = evaluateAlerts({ ...healthy, payouts: [payout("Reverted")] });
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
  });
});

describe("account state keeps entitlements, transfers and DAO principal apart", () => {
  const arena = new FixtureArenaReadSource("near-testnet", {
    battles: new Map([[1, approved()], [2, approved({ locked: true, principal_community: 0, principal_amount: "100" })]]),
    positions: new Map([[FixtureArenaReadSource.positionKey(2, 0, "alice.testnet"), { registered: true, amount: "60" }]]),
    payouts: [payout("Signed"), payout("PendingFinality"), payout("Signed", "bob.testnet")],
  });
  const state = new FixtureStateSource("near-testnet", {
    entitlements: new Map([["doge.rep.testnet|alice.testnet", "40"]]),
    dispositions: new Map([[2, { status: "decided", closes_at_ns: "5", burn_weight: "60", return_weight: "40", escrow_reserved: true, escrow_id: "ab" }]]),
    releases: new Map([[2, [{ id: "r1", kind: "return", beneficiary: "alice.testnet", amount: "24", recorded: true }, { id: "r2", kind: "burn", beneficiary: null, amount: "60", recorded: true }]]]),
    escrows: new Map([["pepe.rep.testnet|ab", { escrowed: "100", returned: "40", burn_pending: "60", burn_confirmed: "0", still_escrowed: "0" }]]),
    indexer: { status: "healthy", reason: "ok", lastSyncMs: NOW },
  });

  it("builds three separate lists with source and observation time", async () => {
    const s = await buildAccountState(
      "alice.testnet",
      [{ battleId: 1, battle: approved() }, { battleId: 2, battle: approved({ locked: true, principal_community: 0, principal_amount: "100" }) }],
      arena,
      state,
      [payout("Signed"), payout("PendingFinality"), payout("Signed", "bob.testnet")],
      NOW,
    );
    expect(s.entitlements).toEqual([{ backing: "doge.rep.testnet", available: "40", source: { kind: "fixture", name: "fixture-state" }, observedAt: new Date(NOW).toISOString() }]);
    expect(s.transfers.map((t) => t.displayState)).toEqual(["reserved", "confirmation_pending"]);
    expect(s.daoPrincipal).toHaveLength(1);
    expect(s.daoPrincipal[0]).toMatchObject({
      battleId: 2,
      position: "60",
      voteStatus: "decided",
      myReturn: { amount: "24", recorded: true },
      escrow: { burn_pending: "60", burn_confirmed: "0" },
    });
  });

  it("serves both tools: account-scoped state and public alerts", async () => {
    const sessions = makeSessions();
    const alice = (await sessions.open(signRead("alice.testnet"))).token;
    const deps = { arena, state, sessions, now: () => NOW };
    const own = await callReadTool("inspect_account_state", { session: alice }, deps);
    expect(own.source.kind).toBe("fixture");
    expect(own.limitations.join(" ")).toMatch(/not observed on any live network/);
    expect((own.data as { accountId: string }).accountId).toBe("alice.testnet");
    await expect(callReadTool("inspect_account_state", { session: alice, accountId: "bob.testnet" }, deps)).rejects.toThrow(/own account/);
    const alerts = await callReadTool("list_recovery_alerts", {}, deps);
    expect((alerts.data as { alerts: unknown[] }).alerts).toEqual([]);
  });
});

describe("indexer health from the indexer's state file", () => {
  it("reads status from state.json, uses its mtime as last sync, and reports missing state as degraded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "valtrum-idx-"));
    try {
      const source = new NearStateSource({ network: "near-testnet", kind: "live", name: "arena" }, async () => null, "arena.testnet", dir);
      expect(await source.indexerHealth()).toMatchObject({ status: "degraded", lastSyncMs: null });
      await writeFile(join(dir, "state.json"), JSON.stringify({ health: { status: "reconciliation_required", reason: "conflict" } }));
      const h = await source.indexerHealth();
      expect(h).toMatchObject({ status: "reconciliation_required", reason: "conflict" });
      expect(typeof h?.lastSyncMs).toBe("number");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
