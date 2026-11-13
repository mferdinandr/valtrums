// FIXTURE-ONLY: fake arena views and providers. No network.
import { describe, expect, it } from "vitest";
import { AuditSubmitter } from "../../src/audit/approval.js";
import { BackingRefresher } from "../../src/audit/backing-refresh.js";
import {
  LOCK_LIFE_MARGIN_MS,
  PREWARM_LEAD_MS,
  createLifecycleAuditPass,
  isIdleBattle,
  prewarmAheadMs,
  type LifecycleBattleView,
} from "../../src/audit/lifecycle-pass.js";
import { staticReferenceRegistry } from "../../src/reference-registry.js";
import { FIXTURE_RESOLVED, NOW, REF_CHAIN, REF_TOKEN, TOKEN, refGoplus, refLp, registry } from "./fixtures.js";

const community = () => ({
  chain_id: "46630",
  token_address: TOKEN,
  representation: "aa.token.testnet",
  custody_domain: "vault-1",
  vault: "1000",
  reference_chain_id: REF_CHAIN,
  reference_address: REF_TOKEN,
});

describe("lifecycle audit fast path", () => {
  it("reads the starting battle first instead of discovering every battle", async () => {
    const startAt = String(NOW.getTime() + 500);
    const views: Record<number, LifecycleBattleView> = {};
    for (let id = 1; id <= 6; id++) views[id] = { locked: false, start_at_ms: startAt, communities: [community(), community()] };
    const reads: number[] = [];
    const wake = { nextStartMs: NOW.getTime() + 500, imminent: [2] };
    const pass = createLifecycleAuditPass({
      source: {
        count: async () => 6,
        get: async (id: number) => {
          reads.push(id);
          return views[id] ?? null;
        },
      },
      wake,
      refresh: {
        policy: FIXTURE_RESOLVED,
        registry: staticReferenceRegistry(registry),
        now: () => NOW,
        refreshAheadMs: 60_000,
        fetchGoPlus: async () => refGoplus(),
        fetchLp: async () => refLp("10001"),
        submitter: new AuditSubmitter("arena.testnet", { call: async () => undefined } as never),
        records: new Map(),
      },
    });

    await pass();
    // Battle 2 is the first one read; battle 6 (the newest) is not read before it.
    expect(reads[0]).toBe(2);
    // The hint is spent, so the next pass rediscovers instead of repeating the fast path.
    expect(wake.imminent).toEqual([]);
    expect(wake.nextStartMs).toBeNull();
  });

  it("stops renewing another battle once a start time passes, and keeps the hint for the fast path", async () => {
    let clock = NOW.getTime();
    const wake: { nextStartMs: number | null; imminent?: number[] } = { nextStartMs: null };
    const views: Record<number, LifecycleBattleView> = {
      // Battle 1 starts in one second; battle 3 is the newest and is audited first.
      1: { locked: false, start_at_ms: String(NOW.getTime() + 1_000), communities: [community(), community()] },
      2: { locked: false, start_at_ms: String(NOW.getTime() + 600_000), communities: [community(), community()] },
      3: { locked: false, start_at_ms: String(NOW.getTime() + 600_000), communities: [community(), community()] },
    };
    let providerCalls = 0;
    const pass = createLifecycleAuditPass({
      source: { count: async () => 3, get: async (id: number) => views[id] ?? null },
      wake,
      refresh: {
        policy: FIXTURE_RESOLVED,
        registry: staticReferenceRegistry(registry),
        now: () => new Date(clock),
        refreshAheadMs: 60_000,
        fetchGoPlus: async () => {
          providerCalls++;
          clock += 2_000; // the audit takes long enough for battle 1's start to pass
          return refGoplus();
        },
        fetchLp: async () => refLp("10001"),
        submitter: new AuditSubmitter("arena.testnet", { call: async () => undefined } as never),
        records: new Map(),
      },
    });

    await pass();
    // Only the first community of battle 3 was audited; the rest waited, and battle 1 was not reached yet.
    expect(providerCalls).toBe(1);
    expect(wake.imminent).toEqual([1]);
    expect(wake.nextStartMs).toBe(NOW.getTime() + 1_000);
  });

  it("publishes the next start and its battles after a normal discovery", async () => {
    const wake: { nextStartMs: number | null; imminent?: number[]; imminentStartMs?: number | null } = { nextStartMs: null };
    const views: Record<number, LifecycleBattleView> = {
      1: { locked: false, start_at_ms: String(NOW.getTime() + 60_000), communities: [community(), community()] },
      2: { locked: false, start_at_ms: String(NOW.getTime() + 20_000), communities: [community(), community()] },
      3: { locked: true, start_at_ms: String(NOW.getTime() + 5_000), communities: [community(), community()] },
    };
    const pass = createLifecycleAuditPass({
      source: { count: async () => 3, get: async (id: number) => views[id] ?? null },
      wake,
      refresh: {
        policy: FIXTURE_RESOLVED,
        registry: staticReferenceRegistry(registry),
        now: () => NOW,
        refreshAheadMs: 60_000,
        fetchGoPlus: async () => refGoplus(),
        fetchLp: async () => refLp("10001"),
        submitter: new AuditSubmitter("arena.testnet", { call: async () => undefined } as never),
        records: new Map(),
      },
    });

    await pass();
    // Battle 3 is locked, so the earliest open start is battle 2.
    expect(wake.nextStartMs).toBe(NOW.getTime() + 20_000);
    expect(wake.imminent).toEqual([2]);
    expect(wake.imminentStartMs).toBe(NOW.getTime() + 20_000);
  });

  it("wakes for the pre-warm, PREWARM_LEAD_MS before a start that is further away", async () => {
    const wake: { nextStartMs: number | null; imminent?: number[]; imminentStartMs?: number | null } = { nextStartMs: null };
    const startAt = NOW.getTime() + 600_000;
    const pass = createLifecycleAuditPass({
      source: { count: async () => 1, get: async () => ({ locked: false, start_at_ms: String(startAt), communities: [community(), community()] }) },
      wake,
      refresh: {
        policy: FIXTURE_RESOLVED,
        registry: staticReferenceRegistry(registry),
        now: () => NOW,
        refreshAheadMs: 60_000,
        fetchGoPlus: async () => refGoplus(),
        fetchLp: async () => refLp("10001"),
        submitter: new AuditSubmitter("arena.testnet", { call: async () => undefined } as never),
        records: new Map(),
      },
    });
    await pass();
    expect(wake.nextStartMs).toBe(startAt - PREWARM_LEAD_MS);
    expect(wake.imminent).toEqual([1]);
    expect(wake.imminentStartMs).toBe(startAt);
  });

  it("a pre-warm renews approvals that would lapse before the lock and keeps the hint for the start", async () => {
    let clock = NOW.getTime();
    let providerCalls = 0;
    const records = new Map();
    const view: LifecycleBattleView = { locked: false, start_at_ms: null, communities: [community(), community()] };
    const wake: { nextStartMs: number | null; imminent?: number[]; imminentStartMs?: number | null } = { nextStartMs: null };
    const pass = createLifecycleAuditPass({
      source: { count: async () => 1, get: async () => view },
      wake,
      refresh: {
        policy: FIXTURE_RESOLVED,
        registry: staticReferenceRegistry(registry),
        now: () => new Date(clock),
        refreshAheadMs: 60_000,
        fetchGoPlus: async () => {
          providerCalls++;
          return refGoplus();
        },
        fetchLp: async () => refLp("10001"),
        submitter: new AuditSubmitter("arena.testnet", { call: async () => undefined } as never),
        records,
      },
    });
    // First audit: both communities get a fresh approval.
    await pass();
    expect(providerCalls).toBe(2);
    const expires = Date.parse(records.get("1:0").expiresAt);
    // 150 s of approval life left: more than the usual 60 s margin, less than the start (100 s away) plus the lock margin.
    clock = expires - 150_000;
    const startAt = clock + 100_000;
    view.start_at_ms = String(startAt);
    wake.nextStartMs = clock;
    wake.imminent = [1];
    wake.imminentStartMs = startAt;
    expect(prewarmAheadMs(startAt, clock)).toBe(100_000 + LOCK_LIFE_MARGIN_MS);
    await pass();
    expect(providerCalls).toBe(4);
    // The hint now points at the start, so the loop wakes again then and the lock goes first.
    expect(wake.nextStartMs).toBe(startAt);
    expect(wake.imminent).toEqual([1]);
  });

  it("prewarmAheadMs is null outside the window and covers the margin once the start passed", () => {
    const now = NOW.getTime();
    expect(prewarmAheadMs(null, now)).toBeNull();
    expect(prewarmAheadMs(now + PREWARM_LEAD_MS + 1, now)).toBeNull();
    expect(prewarmAheadMs(now + 30_000, now)).toBe(30_000 + LOCK_LIFE_MARGIN_MS);
    expect(prewarmAheadMs(now - 5_000, now)).toBe(LOCK_LIFE_MARGIN_MS);
  });

  it("the backing refresh renews an approval inside the pre-warm margin", async () => {
    const calls: number[] = [];
    const refresher = new BackingRefresher({
      contractId: "arena.testnet",
      transport: { call: async (_c: string, _m: string, args: { community: number }) => void calls.push(args.community) } as never,
      now: () => NOW,
      source: { statuses: async () => [{ community: 0, trusted: true, assetMatches: true, fresh: true, expiresAtMs: NOW.getTime() + 200_000 }] },
    });
    // 200 s left is past the usual 180 s margin: nothing is sent.
    expect((await refresher.refresh(1)).sent).toEqual([]);
    // A pre-warm asking for 210 s renews it.
    expect((await refresher.refresh(1, () => true, () => false, { aheadMs: 210_000 })).sent).toEqual([0]);
    expect(calls).toEqual([0]);
  });
});

describe("idle battles (no start time, nothing deposited)", () => {
  const idleCommunity = () => ({ ...community(), vault: "0" });

  it("isIdleBattle needs both: no start time and no funded community", () => {
    expect(isIdleBattle({ locked: false, start_at_ms: null, communities: [idleCommunity(), idleCommunity()] })).toBe(true);
    expect(isIdleBattle({ locked: false, start_at_ms: String(NOW.getTime() + 60_000), communities: [idleCommunity()] })).toBe(false);
    expect(isIdleBattle({ locked: false, start_at_ms: null, communities: [idleCommunity(), community()] })).toBe(false);
  });

  it("audits each community once and does not renew it, until a deposit makes the battle normal again", async () => {
    let clock = NOW.getTime();
    let providerCalls = 0;
    const records = new Map();
    const view: LifecycleBattleView = { locked: false, start_at_ms: null, communities: [idleCommunity(), idleCommunity()] };
    const pass = createLifecycleAuditPass({
      source: { count: async () => 1, get: async () => view },
      refresh: {
        policy: FIXTURE_RESOLVED,
        registry: staticReferenceRegistry(registry),
        now: () => new Date(clock),
        refreshAheadMs: 60_000,
        fetchGoPlus: async () => {
          providerCalls++;
          return refGoplus();
        },
        fetchLp: async () => refLp("10001"),
        submitter: new AuditSubmitter("arena.testnet", { call: async () => undefined } as never),
        records,
      },
    });
    await pass();
    expect(providerCalls).toBe(2);
    // Long after the approvals expired: nothing is renewed for an idle battle.
    clock = Date.parse(records.get("1:0").expiresAt) + 60_000;
    await pass();
    expect(providerCalls).toBe(2);
    // A community that joins later still gets its first audit.
    view.communities.push(idleCommunity());
    await pass();
    expect(providerCalls).toBe(3);
    // The fixture evidence is old by now, so that decision is pending; an idle battle does not retry it either.
    expect(records.get("1:2").result).toBe("pending");
    await pass();
    expect(providerCalls).toBe(3);
    // The first deposit: the battle is normal again, so the two expired approvals are renewed and the pending one retried.
    view.communities[0] = community();
    await pass();
    expect(providerCalls).toBe(6);
  });

  it("the backing refresh of an idle battle sends only for a community that was never backed", async () => {
    const calls: number[] = [];
    const refresher = new BackingRefresher({
      contractId: "arena.testnet",
      transport: { call: async (_c: string, _m: string, args: { community: number }) => void calls.push(args.community) } as never,
      now: () => NOW,
      source: {
        statuses: async () => [
          { community: 0, trusted: true, assetMatches: true, fresh: false, expiresAtMs: NOW.getTime() - 1 },
          { community: 1, trusted: true, assetMatches: false, fresh: false, expiresAtMs: null },
        ],
      },
    });
    expect((await refresher.refresh(1, () => true, () => false, { initialOnly: true })).sent).toEqual([1]);
    expect(calls).toEqual([1]);
  });
});
