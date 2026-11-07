// FIXTURE-ONLY: transports and providers are fakes; no NEAR or GoPlus network is contacted.
import { describe, expect, it } from "vitest";
import {
  AuditSubmitter,
  approvalStatus,
  lockReadiness,
  refreshBattleAudit,
  submitArgs,
  type RefreshDeps,
} from "../../src/audit/approval.js";
import { evaluateCommunity, type AuditRecord } from "../../src/audit/decision.js";
import { FIXTURE_RESOLVED, NOW, asset, goplus, lp } from "./fixtures.js";

const pass = (): AuditRecord =>
  evaluateCommunity({ asset, goplus: goplus(), lp: lp("10001"), policy: FIXTURE_RESOLVED, now: NOW });

describe("approval binding and refresh (fixture-only)", () => {
  it("valid pass binds asset, policy and expiry", () => {
    const r = pass();
    expect(approvalStatus(r, asset, FIXTURE_RESOLVED, NOW)).toEqual({ valid: true });
    expect(approvalStatus(r, { ...asset, mappingVersion: "m2" }, FIXTURE_RESOLVED, NOW)).toEqual({
      valid: false,
      reason: "asset_changed",
    });
    expect(approvalStatus(r, { ...asset, representation: "other.token.testnet" }, FIXTURE_RESOLVED, NOW)).toMatchObject({
      reason: "asset_changed",
    });
    expect(approvalStatus(r, asset, { ...FIXTURE_RESOLVED, version: "v2" }, NOW)).toEqual({
      valid: false,
      reason: "policy_changed",
    }); // policy version is part of the bound hash
  });

  it("policy change (ttl) invalidates; expiry invalidates; non-pass and missing are not approvals", () => {
    const r = pass();
    const changed = { ...FIXTURE_RESOLVED, version: "v2", freshness: { status: "resolved", id: "f2", ttlSeconds: 1 } } as const;
    expect(approvalStatus(r, asset, changed, NOW)).toMatchObject({ reason: "policy_changed" });
    const later = new Date(Date.parse(r.expiresAt!) + 1);
    expect(approvalStatus(r, asset, FIXTURE_RESOLVED, later)).toMatchObject({ reason: "expired" });
    const pend = evaluateCommunity({ asset, goplus: goplus(), lp: null, policy: FIXTURE_RESOLVED, now: NOW });
    expect(approvalStatus(pend, asset, FIXTURE_RESOLVED, NOW)).toMatchObject({ reason: "not_passed" });
    expect(approvalStatus(undefined, asset, FIXTURE_RESOLVED, NOW)).toMatchObject({ reason: "missing" });
  });

  it("lock readiness needs every community valid", () => {
    const r = pass();
    const other = { ...asset, token: "0x00000000000000000000000000000000000000bb" };
    const ready = lockReadiness([asset, other], [r, undefined], FIXTURE_RESOLVED, NOW);
    expect(ready.ready).toBe(false);
    expect(ready.needsRefresh).toEqual([{ index: 1, reason: "missing" }]);
    expect(lockReadiness([asset], [r], FIXTURE_RESOLVED, NOW).ready).toBe(true);
  });

  it("submit args carry the bound asset, hashes and result", () => {
    const r = pass();
    expect(submitArgs(7, 2, r)).toEqual({
      battle_id: 7,
      community: 2,
      asset: {
        chain_id: "46630",
        token_address: asset.token,
        representation: "aa.token.testnet",
        custody_domain: "vault-1",
        reference_chain_id: null,
        reference_address: null,
      },
      result: "pass",
      policy_hash: r.policyHash,
      evidence_hash: r.evidenceHash,
      expires_at_ms: String(Date.parse(r.expiresAt!)),
    });
  });

  function deps(overrides: Partial<RefreshDeps> = {}) {
    const calls: unknown[][] = [];
    let goplusCalls = 0;
    let clock = NOW;
    const submitter = new AuditSubmitter("arena.testnet", {
      call: async (...args: unknown[]) => {
        calls.push(args);
      },
    } as never);
    const d: RefreshDeps = {
      policy: FIXTURE_RESOLVED,
      registry: [],
      now: () => clock,
      fetchGoPlus: async () => {
        goplusCalls++;
        return goplus();
      },
      fetchLp: async () => lp("10001"),
      submitter,
      records: new Map(),
      isLocked: async () => false,
      ...overrides,
    };
    return { d, calls, goplusCalls: () => goplusCalls, setNow: (t: Date) => (clock = t) };
  }

  it("refresh is idempotent: second run makes no provider call or submission", async () => {
    const { d, calls, goplusCalls } = deps();
    const first = await refreshBattleAudit(1, [asset], d);
    expect(first.ready).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toBe("submit_lifecycle_audit");
    expect(calls[0]![3]).toBe("30 Tgas");
    await refreshBattleAudit(1, [asset], d);
    expect(calls).toHaveLength(1);
    expect(goplusCalls()).toBe(1);
  });

  it("expiry before lock triggers re-audit and a fresh submission", async () => {
    const { d, calls, setNow } = deps();
    await refreshBattleAudit(1, [asset], d);
    setNow(new Date(NOW.getTime() + 60 * 60_000));
    // the fake provider still serves old evidence, so the refresh stays pending: lock refused
    const r = await refreshBattleAudit(1, [asset], d);
    expect(r.ready).toBe(false);
    expect(calls).toHaveLength(2);
    expect((calls[1]![2] as { result: string }).result).toBe("pending");
  });

  it("a changed mapping re-audits only the affected community", async () => {
    const { d, calls } = deps();
    await refreshBattleAudit(1, [asset], d);
    const changed = { ...asset, mappingVersion: "m2" };
    const r = await refreshBattleAudit(1, [changed], d);
    expect(r.ready).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("a locked battle is never refreshed or submitted", async () => {
    const { d, calls, goplusCalls } = deps({ isLocked: async () => true });
    const r = await refreshBattleAudit(1, [asset], d);
    expect(r.skippedBecauseLocked).toBe(true);
    expect(calls).toHaveLength(0);
    expect(goplusCalls()).toBe(0);
  });

  it("unresolved policy submits pending, never pass", async () => {
    const { d, calls } = deps({ policy: { ...FIXTURE_RESOLVED, tax: { status: "unresolved" } } });
    const r = await refreshBattleAudit(1, [asset], d);
    expect(r.ready).toBe(false);
    expect((calls[0]![2] as { result: string }).result).toBe("pending");
  });
});
