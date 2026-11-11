// FIXTURE-ONLY: fake transport, views and records; no network is contacted.
import { describe, expect, it } from "vitest";
import { AuditSubmitter } from "../../src/audit/approval.js";
import { BackingRefresher, NearBackingStatusSource, type BackingStatus } from "../../src/audit/backing-refresh.js";
import { loadAuditConfig } from "../../src/audit/config.js";
import type { AuditRecord } from "../../src/audit/decision.js";
import { LifecycleCanceller } from "../../src/audit/lifecycle-cancel.js";
import { LifecycleLocker } from "../../src/audit/lifecycle-lock.js";
import { createLifecycleAuditPass, fundedIndices, type LifecycleBattleView } from "../../src/audit/lifecycle-pass.js";
import { staticReferenceRegistry } from "../../src/reference-registry.js";
import { FIXTURE_RESOLVED, NOW, REF_CHAIN, REF_TOKEN, TOKEN, refGoplus, refLp, registry } from "./fixtures.js";

const rec = (result: "pass" | "pending", expiresAt: string | null): AuditRecord => ({ result, expiresAt }) as unknown as AuditRecord;
const inMs = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const community = (vault: string, token = TOKEN) => ({
  chain_id: "46630", token_address: token, representation: "aa.token.testnet", custody_domain: "vault-1",
  reference_chain_id: REF_CHAIN, reference_address: REF_TOKEN, vault,
});

describe("lock rules of the open arena", () => {
  const mk = (records: Map<string, AuditRecord>, clock = { t: NOW }) => {
    const calls: unknown[][] = [];
    let onChain = false;
    const l = new LifecycleLocker({
      contractId: "arena.testnet",
      transport: { call: async (...a: unknown[]) => { calls.push(a); onChain = true; } },
      records,
      now: () => clock.t,
      isLocked: async () => onChain,
    });
    return { l, calls, clock, setOnChain: (v: boolean) => (onChain = v) };
  };
  const passing = (...indices: number[]) => new Map(indices.map((i) => [`1:${i}`, rec("pass", inMs(600_000))]));

  it("ignores a zero-vault community and passes the total count as expected_communities", async () => {
    // Community 1 is unfunded and has no record at all; the lock does not need it.
    const t = mk(passing(0, 2));
    expect(await t.l.tryLock(1, 3, true, { fundedIndices: [0, 2] })).toEqual({ status: "locked" });
    expect(t.calls[0]![2]).toEqual({ battle_id: 1, expected_communities: 3 });
  });
  it("needs a fresh passing record for every FUNDED community", async () => {
    const t = mk(passing(0));
    expect(await t.l.tryLock(1, 3, true, { fundedIndices: [0, 2] })).toEqual({ status: "not_ready", reason: "community_2_missing" });
    expect(t.calls).toHaveLength(0);
  });
  it("needs at least two funded communities", async () => {
    const t = mk(passing(0, 1, 2));
    expect(await t.l.tryLock(1, 3, true, { fundedIndices: [0] })).toEqual({ status: "not_ready", reason: "too_few_funded" });
    expect(await t.l.tryLock(1, 0, true, { fundedIndices: [] })).toEqual({ status: "not_ready", reason: "no_communities" });
    expect(t.calls).toHaveLength(0);
  });
  it("waits for the start time and locks once it is reached", async () => {
    const t = mk(passing(0, 1));
    const start = NOW.getTime() + 120_000;
    expect(await t.l.tryLock(1, 2, true, { fundedIndices: [0, 1], startAtMs: start })).toEqual({ status: "not_started", startAtMs: start });
    expect(t.calls).toHaveLength(0);
    t.clock.t = new Date(start);
    // Records must still have 60 s of life at the later time.
    for (const k of ["1:0", "1:1"]) (t.l as unknown as { deps: { records: Map<string, AuditRecord> } }).deps.records.set(k, rec("pass", inMs(120_000 + 600_000)));
    expect(await t.l.tryLock(1, 2, true, { fundedIndices: [0, 1], startAtMs: start })).toEqual({ status: "locked" });
  });
  it("never locks a cancelled battle and waits for a missing backing approval", async () => {
    const t = mk(passing(0, 1));
    expect(await t.l.tryLock(1, 2, true, { fundedIndices: [0, 1], cancelled: true })).toEqual({ status: "cancelled" });
    expect(await t.l.tryLock(1, 2, true, { fundedIndices: [0, 1], backingReady: false })).toEqual({ status: "not_ready", reason: "backing_not_ready" });
    expect(t.calls).toHaveLength(0);
  });
  it("is idempotent and restart-safe: a lock that already landed is not sent again", async () => {
    const t = mk(passing(0, 1));
    t.setOnChain(true);
    expect(await t.l.tryLock(1, 2, true, { fundedIndices: [0, 1] })).toEqual({ status: "already_locked" });
    expect(t.calls).toHaveLength(0);
  });
  it("reads funded communities from the view's vaults and treats a missing vault as funded", () => {
    const view = (vaults: (string | undefined)[]): LifecycleBattleView => ({ locked: false, communities: vaults.map((v) => ({ ...community("0"), vault: v })) });
    expect(fundedIndices(view(["5", "0", "7"]))).toEqual([0, 2]);
    expect(fundedIndices(view([undefined, "0"]))).toEqual([0]);
    expect(fundedIndices(view([]))).toEqual([]);
  });
});

describe("audit pass for an open arena", () => {
  function setup(extra: { cancelEnabled?: boolean; backing?: boolean } = {}) {
    let clock = NOW;
    let view: LifecycleBattleView | null = { locked: false, start_at_ms: String(NOW.getTime() + 120_000), cancelled: false, communities: [community("0"), community("0")] };
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    let locked = false;
    let cancelled = false;
    const transport = {
      call: async (_c: string, method: string, args: object) => {
        calls.push({ method, args: args as Record<string, unknown> });
        if (method === "lock_lifecycle_battle") locked = true;
        if (method === "cancel_lifecycle_battle") cancelled = true;
      },
    };
    const records = new Map<string, AuditRecord>();
    const backing: BackingStatus[] = [0, 1, 2].map((community) => ({ community, trusted: true, assetMatches: true, fresh: true, expiresAtMs: NOW.getTime() + 600_000 }));
    const pass = createLifecycleAuditPass({
      source: { count: async () => 1, get: async () => (view ? { ...view, locked, cancelled: cancelled || view.cancelled } : null) },
      refresh: {
        policy: FIXTURE_RESOLVED,
        registry: staticReferenceRegistry(registry),
        now: () => clock,
        refreshAheadMs: 60_000,
        fetchGoPlus: async () => refGoplus(),
        fetchLp: async () => refLp("10001"),
        submitter: new AuditSubmitter("arena.testnet", transport as never),
        records,
      },
      lock: new LifecycleLocker({ contractId: "arena.testnet", transport, records, now: () => clock, isLocked: async () => locked }),
      ...(extra.cancelEnabled
        ? { cancel: new LifecycleCanceller({ contractId: "arena.testnet", transport, now: () => clock, isCancelled: async () => cancelled }) }
        : {}),
      ...(extra.backing
        ? { backing: new BackingRefresher({ contractId: "arena.testnet", transport, now: () => clock, source: { statuses: async () => backing } }) }
        : {}),
    });
    return {
      pass, calls, records, backing,
      setView: (v: LifecycleBattleView | null) => (view = v),
      getView: () => view!,
      setNow: (t: Date) => (clock = t),
      methods: () => calls.map((c) => c.method),
    };
  }
  const fund = (s: ReturnType<typeof setup>, ...idx: number[]) => {
    const v = s.getView();
    s.setView({ ...v, communities: v.communities.map((c, i) => (idx.includes(i) ? { ...c, vault: "100" } : c)) });
  };

  it("audits every community including zero-vault ones, and does not lock before the start", async () => {
    const s = setup();
    fund(s, 0, 1);
    await s.pass();
    expect(s.methods()).toEqual(["submit_lifecycle_audit", "submit_lifecycle_audit"]);
    const empty = setup();
    await empty.pass();
    expect(empty.methods()).toEqual(["submit_lifecycle_audit", "submit_lifecycle_audit"]);
  });
  it("locks at the start time with two funded communities, ignoring an unfunded third, and passes expected_communities", async () => {
    const s = setup();
    const v = s.getView();
    s.setView({ ...v, communities: [...v.communities, community("0")] });
    fund(s, 0, 1);
    await s.pass();
    expect(s.methods()).not.toContain("lock_lifecycle_battle");
    s.setNow(new Date(NOW.getTime() + 120_000));
    await s.pass();
    const lock = s.calls.find((c) => c.method === "lock_lifecycle_battle");
    expect(lock?.args).toEqual({ battle_id: 1, expected_communities: 3 });
    const before = s.calls.length;
    await s.pass();
    expect(s.calls).toHaveLength(before);
  });
  it("does not lock with one funded community", async () => {
    const s = setup();
    fund(s, 0);
    s.setNow(new Date(NOW.getTime() + 130_000));
    await s.pass();
    expect(s.methods()).not.toContain("lock_lifecycle_battle");
  });
  it("picks up an appended community on the next pass", async () => {
    const s = setup();
    await s.pass();
    expect(s.calls.filter((c) => c.method === "submit_lifecycle_audit")).toHaveLength(2);
    const v = s.getView();
    s.setView({ ...v, communities: [...v.communities, community("0")] });
    await s.pass();
    const submits = s.calls.filter((c) => c.method === "submit_lifecycle_audit");
    expect(submits).toHaveLength(3);
    expect(submits[2]!.args.community).toBe(2);
    expect(s.records.has("1:2")).toBe(true);
  });
  it("skips a cancelled battle completely", async () => {
    const s = setup({ cancelEnabled: true });
    s.setView({ ...s.getView(), cancelled: true });
    s.setNow(new Date(NOW.getTime() + 500_000));
    expect(await s.pass()).toEqual({ checked: 0, ready: 0, errors: 0 });
    expect(s.calls).toHaveLength(0);
  });
  it("cancels only when enabled, started, unlocked and under two funded communities", async () => {
    const off = setup();
    off.setNow(new Date(NOW.getTime() + 130_000));
    await off.pass();
    expect(off.methods()).not.toContain("cancel_lifecycle_battle");

    const early = setup({ cancelEnabled: true });
    await early.pass();
    expect(early.methods()).not.toContain("cancel_lifecycle_battle");

    const ok = setup({ cancelEnabled: true });
    fund(ok, 0);
    ok.setNow(new Date(NOW.getTime() + 130_000));
    await ok.pass();
    expect(ok.calls.filter((c) => c.method === "cancel_lifecycle_battle")).toEqual([{ method: "cancel_lifecycle_battle", args: { battle_id: 1 } }]);
    await ok.pass();
    expect(ok.calls.filter((c) => c.method === "cancel_lifecycle_battle")).toHaveLength(1);

    const enough = setup({ cancelEnabled: true });
    fund(enough, 0, 1);
    enough.setNow(new Date(NOW.getTime() + 130_000));
    await enough.pass();
    expect(enough.methods()).not.toContain("cancel_lifecycle_battle");
    expect(enough.methods()).toContain("lock_lifecycle_battle");
  });
  it("a battle without a start time is never cancelled", async () => {
    const s = setup({ cancelEnabled: true });
    s.setView({ ...s.getView(), start_at_ms: null });
    s.setNow(new Date(NOW.getTime() + 10_000_000));
    await s.pass();
    expect(s.methods()).not.toContain("cancel_lifecycle_battle");
  });
  it("does not lock while a funded community's backing approval is missing, and locks once it is fresh", async () => {
    const s = setup({ backing: true });
    fund(s, 0, 1);
    s.setNow(new Date(NOW.getTime() + 130_000));
    s.backing[1] = { ...s.backing[1]!, fresh: false, expiresAtMs: null };
    await s.pass();
    expect(s.methods()).toContain("refresh_lifecycle_backing");
    expect(s.methods()).not.toContain("lock_lifecycle_battle");
    s.backing[1] = { ...s.backing[1]!, fresh: true, expiresAtMs: NOW.getTime() + 130_000 + 600_000 };
    s.backing[0] = { ...s.backing[0]!, expiresAtMs: NOW.getTime() + 130_000 + 600_000 };
    await s.pass();
    expect(s.methods()).toContain("lock_lifecycle_battle");
  });
});

describe("backing refresh", () => {
  const status = (community: number, over: Partial<BackingStatus> = {}): BackingStatus => ({
    community, trusted: true, assetMatches: true, fresh: true, expiresAtMs: NOW.getTime() + 600_000, ...over,
  });
  function mk(statuses: BackingStatus[], failing = false) {
    const calls: unknown[][] = [];
    let clock = NOW;
    const r = new BackingRefresher({
      contractId: "arena.testnet",
      transport: { call: async (...a: unknown[]) => { calls.push(a); if (failing) throw new Error("boom"); } },
      source: { statuses: async () => statuses },
      now: () => clock,
    });
    return { r, calls, setNow: (t: Date) => (clock = t) };
  }
  it("sends refresh_lifecycle_backing with a storage deposit only for missing or lapsing approvals", async () => {
    const t = mk([status(0), status(1, { fresh: false, expiresAtMs: null }), status(2, { expiresAtMs: NOW.getTime() + 100_000 })]);
    const out = await t.r.refresh(7);
    expect(out.sent).toEqual([1, 2]);
    expect(out.ready).toEqual(new Set([0, 2]));
    expect(t.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ["arena.testnet", "refresh_lifecycle_backing", { battle_id: 7, community: 1 }],
      ["arena.testnet", "refresh_lifecycle_backing", { battle_id: 7, community: 2 }],
    ]);
    expect(t.calls[0]![3]).toMatch(/Tgas/);
    expect(t.calls[0]![4]).toBe("0.01 NEAR");
  });
  it("does not repeat a send inside the retry window and sends again after it", async () => {
    const t = mk([status(0, { fresh: false, expiresAtMs: null })]);
    await t.r.refresh(1);
    await t.r.refresh(1);
    expect(t.calls).toHaveLength(1);
    t.setNow(new Date(NOW.getTime() + 31_000));
    await t.r.refresh(1);
    expect(t.calls).toHaveLength(2);
  });
  it("skips untrusted representations and communities the audit has not passed, and reports failures", async () => {
    const t = mk([status(0, { trusted: false, fresh: false, expiresAtMs: null }), status(1, { fresh: false, expiresAtMs: null }), status(2, { fresh: false, expiresAtMs: null })]);
    const out = await t.r.refresh(1, (i) => i !== 1);
    expect(out.failed).toEqual([0]);
    expect(out.sent).toEqual([2]);
    const bad = mk([status(0, { fresh: false, expiresAtMs: null })], true);
    expect((await bad.r.refresh(1)).failed).toEqual([0]);
  });
  it("reads the arena readiness view for the statuses", async () => {
    const seen: unknown[][] = [];
    const src = new NearBackingStatusSource("arena.testnet", {
      view: (async (...a: unknown[]) => {
        seen.push(a);
        return { backings: [{ community: 0, representation: "x", trusted: true, asset_matches: true, evidence_hash: null, expires_at_ms: "123", fresh: true }] };
      }) as never,
    });
    expect(await src.statuses(5)).toEqual([{ community: 0, trusted: true, assetMatches: true, fresh: true, expiresAtMs: 123 }]);
    expect(seen[0]).toEqual(["arena.testnet", "get_lifecycle_readiness_v1", { battle_id: "5" }]);
  });
});

describe("cancel step", () => {
  it("is idempotent, bounded and re-reads the chain before resending", async () => {
    let clock = NOW;
    let onChain = false;
    const calls: unknown[][] = [];
    const c = new LifecycleCanceller({
      contractId: "arena.testnet",
      transport: { call: async (...a: unknown[]) => { calls.push(a); throw new Error("x".repeat(1000)); } },
      now: () => clock,
      isCancelled: async () => onChain,
    });
    const ctx = { startAtMs: NOW.getTime() - 1, locked: false, cancelled: false, funded: 1 };
    const first = await c.tryCancel(1, ctx);
    expect(first.status).toBe("failed");
    expect((first as { error: string }).error.length).toBeLessThanOrEqual(300);
    expect(await c.tryCancel(1, ctx)).toEqual({ status: "backoff" });
    // The cancel landed meanwhile (for example sent by someone else): no second send.
    onChain = true;
    clock = new Date(NOW.getTime() + 31_000);
    expect(await c.tryCancel(1, ctx)).toEqual({ status: "already_cancelled" });
    expect(calls).toHaveLength(1);
    expect(await c.tryCancel(2, { ...ctx, locked: true })).toEqual({ status: "not_applicable", reason: "locked" });
  });
});

describe("audit config flags", () => {
  const env = { AUDIT_ENABLED: "true", REFERENCE_RPC_URL: "https://rpc.example" };
  it("cancel is off by default and backing refresh is on unless disabled", () => {
    expect(loadAuditConfig(env, 30)).toMatchObject({ cancelEnabled: false, backingRefreshEnabled: true });
    expect(loadAuditConfig({ ...env, AUDIT_CANCEL_ENABLED: "true" }, 30)!.cancelEnabled).toBe(true);
    expect(loadAuditConfig({ ...env, AUDIT_CANCEL_ENABLED: "yes" }, 30)!.cancelEnabled).toBe(false);
    expect(loadAuditConfig({ ...env, AUDIT_BACKING_REFRESH_ENABLED: "false" }, 30)!.backingRefreshEnabled).toBe(false);
  });
});
