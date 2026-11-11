// FIXTURE-ONLY: synthetic lifecycle payloads. Not live chain data.
import { describe, expect, it, vi } from "vitest";
import { arenaBlockers, battleStatus, communityRows, communityApproval, fetchLifecycleBattle, roundPhase, type LifecycleDetail } from "./lifecycle";
import type { Namespace } from "./application";

const namespace: Namespace = { deploymentId: "arena-v1", network: "near-testnet", arenaContract: "arena.testnet", protocol: "lifecycle-v2" };
const community = (i: number, over: Record<string, unknown> = {}) => ({
  chain_id: "46630", token_address: `0x${String(i).repeat(40)}`, representation: `c${i}.rep.testnet`, custody_domain: "custody-v1",
  reference_chain_id: null, reference_address: null, vault: "18446744073709551615", audit_policy_hash: "p", audit_evidence_hash: "ae", audit_expires_at_ms: "2000", backing_evidence_hash: "be", ...over,
});
const detail = (over: Partial<LifecycleDetail> = {}): LifecycleDetail => ({
  battleId: "7",
  battle: { creator: "a.testnet", protocol: "p.testnet", protocol_created: false, fee_bps: 10, creator_share_bps: 5000, mode: "PriceGain", locked: true,
    observation_policy_version: "1", observation_policy_hash: "h", principal_community: null, principal_amount: null, communities: [community(1), community(2), community(3)] },
  round: { round_id: "1", candidates: [0, 1, 2], start_ns: "1000000000", end_ns: "31000000000", winner: null },
  readiness: { schema_version: "lifecycle-application-v1", activated: true, paused: false, legacy_battle_count: "0", activation_blocked_by_legacy: false, protocol: null, oracle: "o.testnet", audit_policy_hash: null, battle_found: true,
    backings: [0, 1, 2].map((community) => ({ community, representation: `c${community + 1}.rep.testnet`, trusted: true, asset_matches: true, evidence_hash: "be", expires_at_ms: "99999", fresh: true })) },
  history: null, ...over,
});

describe("round phase", () => {
  const round = detail().round;
  it("describes the window by the clock but never picks a winner from it", () => {
    expect(roundPhase(null, 1)).toEqual({ kind: "not_started" });
    expect(roundPhase({ ...round!, start_ns: null, end_ns: null }, 5)).toMatchObject({ kind: "awaiting_open" });
    expect(roundPhase(round, 10_000)).toMatchObject({ kind: "window_open", msLeft: 21_000 });
    // After the recorded end it says "awaiting resolution", still no winner.
    const late = roundPhase(round, 31_000 + 600_000);
    expect(late).toMatchObject({ kind: "awaiting_resolution" });
    expect(JSON.stringify(late)).not.toMatch(/winner/);
  });
  it("shows a winner only when the contract recorded one", () => {
    expect(roundPhase({ ...round!, winner: 1 }, 1)).toEqual({ kind: "decided", winner: 1 });
    expect(roundPhase({ ...round!, winner: 0 }, 99_999_999)).toEqual({ kind: "decided", winner: 0 });
  });
  it("does not misread an unread clock as expiry", () => {
    expect(roundPhase(round, 0)).toMatchObject({ kind: "window_open" });
  });
});

describe("community rows", () => {
  it("does not call a credited vault pending when readiness is unavailable", () => {
    const unknown = communityRows(detail({ readiness: null }), 1000)[0]!;
    expect(BigInt(unknown.vault)).toBeGreaterThan(0n);
    expect(communityApproval(unknown)).toEqual({ label: "Approval status unavailable", approved: false });
    const approved = communityRows(detail(), 1000)[0]!;
    expect(communityApproval(approved)).toEqual({ label: "Approved", approved: true });
    expect(communityApproval({ ...approved, audit: { ...approved.audit, state: "expired" } })).toEqual({ label: "Approval expired", approved: false });
    expect(communityApproval({ ...approved, backing: { ...approved.backing, fresh: false } }).label).toBe("Waiting for approval");
  });
  it("keeps u128 vaults exact and binds identity from the contract, not from symbols", () => {
    const rows = communityRows(detail(), 1000);
    expect(rows[0]).toMatchObject({ vault: "18446744073709551615", asset: `46630:0x${"1".repeat(40)}`, reference: null, blockers: [] });
    const withRef = communityRows(detail({ battle: { ...detail().battle, communities: [community(1, { reference_chain_id: "4663", reference_address: "0xbb" }), community(2), community(3)] } }), 1000);
    expect(withRef[0]?.reference).toBe("4663:0xbb");
  });

  it("lists the specific reason a community is not ready", () => {
    const d = detail();
    d.battle.communities[0] = community(1, { audit_evidence_hash: null });
    d.battle.communities[1] = community(2, { audit_expires_at_ms: "500" });
    d.readiness!.backings![2] = { ...d.readiness!.backings![2]!, trusted: false, asset_matches: false, fresh: false };
    const rows = communityRows(d, 1000);
    expect(rows[0]?.blockers).toEqual(["no audit approval recorded"]);
    expect(rows[1]?.blockers).toEqual(["audit approval expired"]);
    expect(rows[2]?.blockers).toEqual(["representation is not trusted", "backing approval is for another asset", "backing approval missing or expired"]);
  });

  it("reports missing backing readiness instead of assuming it", () => {
    expect(communityRows(detail({ readiness: null }), 1000)[0]?.blockers).toContain("backing readiness unavailable");
  });

  it("marks eliminated communities from the recorded candidates and the recorded winner only", () => {
    const overtime = communityRows(detail({ round: { round_id: "2", candidates: [0, 2], start_ns: null, end_ns: null, winner: null } }), 1000);
    expect(overtime.map((r) => r.eliminated)).toEqual([false, true, false]);
    const done = communityRows(detail({ round: { round_id: "2", candidates: [0, 2], start_ns: "1", end_ns: "2", winner: 2 } }), 1000);
    expect(done.map((r) => r.recordedWinner)).toEqual([false, false, true]);
    expect(done.map((r) => r.eliminated)).toEqual([false, false, false]);
  });
});

describe("status and readiness", () => {
  it("derives status from lock and the recorded winner only", () => {
    expect(battleStatus(detail({ battle: { ...detail().battle, locked: false } }))).toBe("open");
    expect(battleStatus(detail())).toBe("locked");
    expect(battleStatus(detail({ round: { ...detail().round!, winner: 0 } }))).toBe("decided");
  });
  it("blocks on inactive, paused or unknown arena state", () => {
    expect(arenaBlockers(detail().readiness)).toEqual([]);
    expect(arenaBlockers({ ...detail().readiness!, activated: false, activation_blocked_by_legacy: true, paused: true })).toEqual(["lifecycle is not activated: legacy battles block activation", "the arena is paused"]);
    expect(arenaBlockers(null)).toEqual(["lifecycle readiness unavailable"]);
  });
});

describe("fetchLifecycleBattle", () => {
  const ok = (battleId: string) => async () => Response.json({ schemaVersion: "arena-application-v1", namespace, provenance: { kind: "rpc" }, data: { ...detail(), battleId } });
  it("calls the versioned route and rejects another battle, a bad id and a backend error without a fallback", async () => {
    const doFetch = vi.fn(async (_url: string, _init: RequestInit) => ok("7")());
    await fetchLifecycleBattle(namespace, "7", new AbortController().signal, doFetch);
    expect(doFetch.mock.calls[0]![0]).toBe("/api/arena/v1/battles/7?deployment=arena-v1&protocol=lifecycle-v2");
    await expect(fetchLifecycleBattle(namespace, "8", new AbortController().signal, ok("7"))).rejects.toThrow("another battle");
    await expect(fetchLifecycleBattle(namespace, "0", new AbortController().signal, ok("0"))).rejects.toThrow("invalid battle id");
    const down = async () => Response.json({ error: { code: "upstream_unavailable", message: "read source unavailable" } }, { status: 503 });
    await expect(fetchLifecycleBattle(namespace, "7", new AbortController().signal, down)).rejects.toThrow("read source unavailable");
  });
});
