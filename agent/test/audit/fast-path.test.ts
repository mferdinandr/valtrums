// FIXTURE-ONLY: fake arena views and providers. No network.
import { describe, expect, it } from "vitest";
import { AuditSubmitter } from "../../src/audit/approval.js";
import { createLifecycleAuditPass, type LifecycleBattleView } from "../../src/audit/lifecycle-pass.js";
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
    const wake: { nextStartMs: number | null; imminent?: number[] } = { nextStartMs: null };
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
  });
});
