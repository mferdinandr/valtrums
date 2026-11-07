// FIXTURE-ONLY: fake arena views, providers and transport; no network is contacted.
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

const view = (locked = false): LifecycleBattleView => ({
  locked,
  communities: [
    { chain_id: "46630", token_address: TOKEN, representation: "aa.token.testnet", custody_domain: "vault-1" },
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
      registry,
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
        registry,
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

  it("config is off by default, defaults the TTL to 600 s, and validates the reference RPC and registry", () => {
    expect(loadAuditConfig({}, 30)).toBeNull();
    const env = {
      AUDIT_ENABLED: "true",
      REFERENCE_RPC_URL: "https://rpc.example/mainnet",
      AUDIT_REFERENCE_REGISTRY: JSON.stringify([
        { chain_id: "46630", token: TOKEN, reference_chain_id: "4663", reference_address: REF_TOKEN },
      ]),
      AUDIT_STABLECOINS: JSON.stringify({ "0x00000000000000000000000000000000000000c1": 6 }),
      AUDIT_LP_POOLS: JSON.stringify([{ pool: "0x00000000000000000000000000000000000000f1", kind: "v2" }]),
    };
    const cfg = loadAuditConfig(env, 30)!;
    expect(cfg.ttlSeconds).toBe(600);
    expect(cfg.registry).toHaveLength(1);
    expect(cfg.stablecoins.get("0x00000000000000000000000000000000000000c1")).toBe(6);
    expect(loadAuditConfig({ ...env, AUDIT_EVIDENCE_TTL_SECS: "120" }, 30)!.ttlSeconds).toBe(120);
    expect(() => loadAuditConfig({ ...env, AUDIT_EVIDENCE_TTL_SECS: "60" }, 30)).toThrow(/twice/);
    expect(() => loadAuditConfig({ ...env, AUDIT_EVIDENCE_TTL_SECS: "x" }, 30)).toThrow();
    expect(() => loadAuditConfig({ ...env, REFERENCE_RPC_URL: undefined }, 30)).toThrow(/REFERENCE_RPC_URL/);
    expect(() => loadAuditConfig({ ...env, REFERENCE_RPC_URL: "http://rpc.example" }, 30)).toThrow(/https/);
    expect(loadAuditConfig({ ...env, REFERENCE_RPC_URL: "http://localhost:8545" }, 30)).not.toBeNull();
    expect(() => loadAuditConfig({ ...env, AUDIT_REFERENCE_REGISTRY: "{" }, 30)).toThrow(/valid JSON/);
    expect(() =>
      loadAuditConfig(
        {
          ...env,
          AUDIT_REFERENCE_REGISTRY: JSON.stringify([
            { chain_id: "46630", token: TOKEN, reference_chain_id: "1", reference_address: REF_TOKEN },
          ]),
        },
        30,
      ),
    ).toThrow();
  });
});
