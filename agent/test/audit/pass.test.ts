// FIXTURE-ONLY: fake arena views, providers and transport; no network is contacted.
import { staticReferenceRegistry } from "../../src/reference-registry.js";
import { describe, expect, it } from "vitest";
import { AuditSubmitter } from "../../src/audit/approval.js";
import { loadAuditConfig } from "../../src/audit/config.js";
import {
  createLifecycleAuditPass,
  type LifecycleAuditSource,
  type LifecycleBattleView,
} from "../../src/audit/lifecycle-pass.js";
import { AuditReportStore } from "../../src/audit/report.js";
import { MarketAuditor } from "../../src/auditor.js";
import { InMemoryBaselineStore } from "../../src/baseline.js";
import { MockStepExecutor } from "../../src/executor.js";
import { FakeArenaClient } from "../../src/fake-client.js";
import { runOnce } from "../../src/runtime.js";
import { TwapFetcher } from "../../src/twap.js";
import { FIXTURE_RESOLVED, NOW, REF_CHAIN, REF_TOKEN, TOKEN, refGoplus, refLp, registry } from "./fixtures.js";

const view = (
  locked = false,
  pair: { reference_chain_id?: string | null; reference_address?: string | null } = {
    reference_chain_id: REF_CHAIN,
    reference_address: REF_TOKEN,
  },
): LifecycleBattleView => ({
  locked,
  communities: [
    {
      chain_id: "46630",
      token_address: TOKEN,
      representation: "aa.token.testnet",
      custody_domain: "vault-1",
      ...pair,
    },
  ],
});

function source(views: Record<number, LifecycleBattleView>): LifecycleAuditSource {
  return {
    count: async () => Object.keys(views).length,
    get: async (id) => views[id] ?? null,
  };
}

function setup(views: Record<number, LifecycleBattleView>) {
  let clock = NOW;
  const calls: unknown[][] = [];
  const queries: { chainId: string; token: string }[] = [];
  const reports = new AuditReportStore();
  const pass = createLifecycleAuditPass({
    source: source(views),
    reports,
    refresh: {
      policy: FIXTURE_RESOLVED,
      registry: staticReferenceRegistry(registry),
      now: () => clock,
      refreshAheadMs: 60_000,
      fetchGoPlus: async (q) => {
        queries.push(q);
        return refGoplus();
      },
      fetchLp: async () => refLp("10001"),
      submitter: new AuditSubmitter("arena.testnet", { call: async (...a: unknown[]) => void calls.push(a) } as never),
      records: new Map(),
    },
  });
  return { pass, calls, queries, reports, setNow: (t: Date) => (clock = t) };
}

describe("lifecycle audit pass (fixture-only)", () => {
  it("audits unlocked battles against the reference pair and stores a report by evidence hash", async () => {
    const s = setup({ 1: view() });
    expect(await s.pass()).toEqual({ checked: 1, ready: 1, errors: 0 });
    expect(s.queries).toEqual([{ chainId: REF_CHAIN, token: REF_TOKEN }]);
    const sent = s.calls[0]![2] as { evidence_hash: string; result: string };
    expect(sent.result).toBe("pass");
    expect(s.reports.get(sent.evidence_hash)?.auditKind).toBe("reference_token");
  });

  it("submits the committed reference pair so the contract can match the asset", async () => {
    const s = setup({ 1: view() });
    await s.pass();
    const asset = (s.calls[0]![2] as { asset: Record<string, unknown> }).asset;
    expect(asset).toMatchObject({ reference_chain_id: REF_CHAIN, reference_address: REF_TOKEN });
  });

  it("holds Pending when the committed pair differs from, or is absent against, the registry", async () => {
    const other = "0x00000000000000000000000000000000000000dd";
    for (const pair of [
      { reference_chain_id: REF_CHAIN, reference_address: other }, // different token than the registry
      { reference_chain_id: null, reference_address: null }, // registry maps it but nothing committed
    ]) {
      const s = setup({ 1: view(false, pair) });
      expect(await s.pass()).toEqual({ checked: 1, ready: 0, errors: 0 });
      expect(s.queries).toHaveLength(0);
      const sent = s.calls[0]![2] as { result: string; asset: { reference_address: string | null } };
      expect(sent.result).toBe("pending");
      // The pending result still names the committed asset, so the contract accepts it.
      expect(sent.asset.reference_address).toBe(pair.reference_address);
    }
  });

  it("holds Pending when a committed pair is not in the registry at all", async () => {
    const s = setup({ 1: view() });
    const pass = createLifecycleAuditPass({
      source: source({ 1: view(false, { reference_chain_id: "4663", reference_address: "0x00000000000000000000000000000000000000ee" }) }),
      refresh: {
        policy: FIXTURE_RESOLVED,
        registry: staticReferenceRegistry([]),
        now: () => NOW,
        fetchGoPlus: async () => refGoplus(),
        fetchLp: async () => refLp("10001"),
        submitter: new AuditSubmitter("arena.testnet", { call: async (...a: unknown[]) => void s.calls.push(a) } as never),
        records: new Map(),
      },
    });
    expect((await pass()).ready).toBe(0);
    expect((s.calls[0]![2] as { result: string }).result).toBe("pending");
  });

  it("skips locked battles entirely", async () => {
    const s = setup({ 1: view(true) });
    expect(await s.pass()).toEqual({ checked: 0, ready: 0, errors: 0 });
    expect(s.calls).toHaveLength(0);
    expect(s.queries).toHaveLength(0);
  });

  it("does not repeat work while the approval has life left, and refreshes before the TTL ends", async () => {
    const s = setup({ 1: view() });
    await s.pass();
    s.setNow(new Date(NOW.getTime() + 60_000));
    await s.pass();
    expect(s.queries).toHaveLength(1);
    // inside the refresh-ahead margin (60 s before expiry at 600 s TTL from the query time)
    s.setNow(new Date(Date.parse("2026-11-07T11:59:00.000Z") + 560_000));
    await s.pass();
    expect(s.queries).toHaveLength(2);
  });

  it("isolates a failing battle from the others", async () => {
    const bad: LifecycleAuditSource = {
      count: async () => 2,
      get: async (id) => {
        if (id === 1) throw new Error("rpc down");
        return view();
      },
    };
    const s = setup({});
    const pass = createLifecycleAuditPass({
      source: bad,
      refresh: {
        policy: FIXTURE_RESOLVED,
        registry: staticReferenceRegistry(registry),
        now: () => NOW,
        fetchGoPlus: async () => refGoplus(),
        fetchLp: async () => refLp("10001"),
        submitter: new AuditSubmitter("arena.testnet", { call: async () => undefined } as never),
        records: new Map(),
      },
    });
    expect(await pass()).toEqual({ checked: 1, ready: 1, errors: 1 });
    void s;
  });
});

describe("runOnce lifecycle audit hook and config (fixture-only)", () => {
  it("runs the audit every pass and counts its errors", async () => {
    let runs = 0;
    const client = new FakeArenaClient([]);
    const base = {
      client,
      auditor: new MarketAuditor(
        { liquidityUsd: async () => 50_000 },
        { check: async () => ({ honeypot: false, detail: "ok" }) },
      ),
      baselines: new InMemoryBaselineStore(),
      twap: new TwapFetcher({ samples: async () => [] }, { now: () => 0 }),
      sampler: { sampleOnce: async () => undefined },
      liquidity: { liquidityUsd: async () => 50_000 },
      executor: new MockStepExecutor(),
      nowMs: () => 0,
    };
    const ok = await runOnce({ ...base, lifecycleAudit: async () => (runs++, { errors: 0 }) });
    expect(runs).toBe(1);
    expect(ok.errors).toBe(0);
    const failing = await runOnce({ ...base, lifecycleAudit: async () => ({ errors: 2 }) });
    expect(failing.errors).toBe(2);
    const thrown = await runOnce({
      ...base,
      lifecycleAudit: async () => {
        throw new Error("boom");
      },
    });
    expect(thrown.errors).toBe(1);
  });

  it("WETH pricing config has no defaults and validates its parts", () => {
    const env = { AUDIT_ENABLED: "true", REFERENCE_RPC_URL: "https://rpc.example/mainnet" };
    expect(loadAuditConfig(env, 30)!.weth).toBeUndefined();
    const addr = "0x00000000000000000000000000000000000000c3";
    const pool = "0x00000000000000000000000000000000000000e1";
    expect(() => loadAuditConfig({ ...env, AUDIT_WETH_PRICE_POOL: pool }, 30)).toThrow(/AUDIT_WETH_ADDRESS/);
    expect(() => loadAuditConfig({ ...env, AUDIT_WETH_ADDRESS: addr }, 30)).toThrow(/AUDIT_WETH_CHAIN_ID/);
    const full = {
      ...env,
      AUDIT_WETH_ADDRESS: addr,
      AUDIT_WETH_CHAIN_ID: "4663",
      AUDIT_WETH_PRICE_POOL: pool,
      AUDIT_WETH_PRICE_POOL_MIN_USD: "1000000",
    };
    expect(loadAuditConfig(full, 30)!.weth).toEqual({
      address: addr,
      chainId: "4663",
      pricePool: pool,
      pricePoolMinUsd: "1000000",
    });
    // Pool and floor stay optional: unset means WETH-quoted pools are unpriced (Pending).
    const bare = loadAuditConfig({ ...env, AUDIT_WETH_ADDRESS: addr, AUDIT_WETH_CHAIN_ID: "4663" }, 30)!;
    expect(bare.weth?.pricePool).toBeUndefined();
    expect(bare.weth?.pricePoolMinUsd).toBeUndefined();
    expect(() => loadAuditConfig({ ...full, AUDIT_WETH_PRICE_POOL_MIN_USD: "1e6" }, 30)).toThrow(/decimal/);
    expect(() => loadAuditConfig({ ...full, AUDIT_WETH_PRICE_POOL: "nope" }, 30)).toThrow(/20-byte/);
  });

  it("config is off by default, defaults the TTL to 600 s, and validates the reference RPC, and refuses the removed env registry", () => {
    expect(loadAuditConfig({}, 30)).toBeNull();
    const env = {
      AUDIT_ENABLED: "true",
      REFERENCE_RPC_URL: "https://rpc.example/mainnet",
      AUDIT_STABLECOINS: JSON.stringify({ "0x00000000000000000000000000000000000000c1": 6 }),
      AUDIT_LP_POOLS: JSON.stringify([{ pool: "0x00000000000000000000000000000000000000f1", kind: "v2" }]),
    };
    const cfg = loadAuditConfig(env, 30)!;
    expect(cfg.ttlSeconds).toBe(600);
    expect(cfg).not.toHaveProperty("registry");
    expect(cfg.stablecoins.get("0x00000000000000000000000000000000000000c1")).toBe(6);
    expect(loadAuditConfig({ ...env, AUDIT_EVIDENCE_TTL_SECS: "120" }, 30)!.ttlSeconds).toBe(120);
    expect(() => loadAuditConfig({ ...env, AUDIT_EVIDENCE_TTL_SECS: "60" }, 30)).toThrow(/twice/);
    expect(() => loadAuditConfig({ ...env, AUDIT_EVIDENCE_TTL_SECS: "x" }, 30)).toThrow();
    expect(() => loadAuditConfig({ ...env, REFERENCE_RPC_URL: undefined }, 30)).toThrow(/REFERENCE_RPC_URL/);
    expect(() => loadAuditConfig({ ...env, REFERENCE_RPC_URL: "http://rpc.example" }, 30)).toThrow(/https/);
    expect(loadAuditConfig({ ...env, REFERENCE_RPC_URL: "http://localhost:8545" }, 30)).not.toBeNull();
    // The registry now lives on-chain; setting the old variable fails startup instead of being ignored.
    expect(() => loadAuditConfig({ ...env, AUDIT_REFERENCE_REGISTRY: "[]" }, 30)).toThrow(/on-chain registry/);
    expect(() => loadAuditConfig({ ...env, AUDIT_REFERENCE_REGISTRY: "" }, 30)).toThrow(/on-chain registry/);
  });

  it("reads each finished battle once per pass and does not scan or re-read it while auditing the open one", async () => {
    const views: Record<number, LifecycleBattleView> = {
      1: { ...view(true) }, 2: { ...view(true) }, 3: { ...view(true) }, 4: { ...view(true) }, 5: view(),
    };
    const reads = new Map<number, number>();
    const counting: LifecycleAuditSource = {
      count: async () => 5,
      get: async (id) => {
        reads.set(id, (reads.get(id) ?? 0) + 1);
        return views[id] ?? null;
      },
    };
    const pass = createLifecycleAuditPass({
      source: counting,
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
    expect(await pass()).toMatchObject({ errors: 0 });
    // Finished battles: one read in discovery, nothing more.
    for (const id of [1, 2, 3, 4]) expect(reads.get(id)).toBe(1);
  });

  it("visits an idle battle (no start time, nothing deposited) once and then only reads it in discovery", async () => {
    const idleView: LifecycleBattleView = {
      locked: false,
      communities: [{ chain_id: "46630", token_address: TOKEN, representation: "aa.token.testnet", custody_domain: "vault-1", reference_chain_id: REF_CHAIN, reference_address: REF_TOKEN, vault: "0" }],
    };
    let reads = 0;
    const queries: unknown[] = [];
    const calls: unknown[] = [];
    const counting: LifecycleAuditSource = {
      count: async () => 1,
      get: async () => {
        reads++;
        return idleView;
      },
    };
    const pass = createLifecycleAuditPass({
      source: counting,
      refresh: {
        policy: FIXTURE_RESOLVED,
        registry: staticReferenceRegistry(registry),
        now: () => NOW,
        refreshAheadMs: 60_000,
        fetchGoPlus: async (q) => {
          queries.push(q);
          return refGoplus();
        },
        fetchLp: async () => refLp("10001"),
        submitter: new AuditSubmitter("arena.testnet", { call: async (...a: unknown[]) => void calls.push(a) } as never),
        records: new Map(),
      },
    });
    await pass();
    expect(queries).toHaveLength(1);
    expect(calls.length).toBeGreaterThan(0);
    const firstPassReads = reads;
    reads = 0;
    await pass();
    await pass();
    // Two more passes: the discovery read each, nothing else; no new audit or submission.
    expect(reads).toBe(2);
    expect(reads).toBeLessThan(firstPassReads * 2);
    expect(queries).toHaveLength(1);
  });
});
