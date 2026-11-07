// FIXTURE-ONLY: fake arena views and providers; the archive sink is in-memory. No network.
import { describe, expect, it } from "vitest";
import { AuditSubmitter } from "../../src/audit/approval.js";
import {
  createLifecycleAuditPass,
  type LifecycleAuditSource,
  type LifecycleBattleView,
  type ReportArchiveSink,
} from "../../src/audit/lifecycle-pass.js";
import { InMemoryReportArchive, type ArchiveObservationInput, type PutResult } from "../../src/audit/report-archive.js";
import { AuditReportStore } from "../../src/audit/report.js";
import { FIXTURE_RESOLVED, NOW, REF_CHAIN, REF_TOKEN, TOKEN, refGoplus, refLp, registry } from "./fixtures.js";

const view = (
  locked = false,
  pair: { reference_chain_id?: string | null; reference_address?: string | null } = {
    reference_chain_id: REF_CHAIN,
    reference_address: REF_TOKEN,
  },
): LifecycleBattleView => ({
  locked,
  communities: [{ chain_id: "46630", token_address: TOKEN, representation: "aa.token.testnet", custody_domain: "vault-1", ...pair }],
});

function source(views: Record<number, LifecycleBattleView>): LifecycleAuditSource {
  return { count: async () => Object.keys(views).length, get: async (id) => views[id] ?? null };
}

function baseRefresh(queries: { chainId: string; token: string }[], calls: unknown[][]) {
  return {
    policy: FIXTURE_RESOLVED,
    registry,
    now: () => NOW,
    refreshAheadMs: 60_000,
    fetchGoPlus: async (q: { chainId: string; token: string }) => {
      queries.push(q);
      return refGoplus();
    },
    fetchLp: async () => refLp("10001"),
    submitter: new AuditSubmitter("arena.testnet", { call: async (...a: unknown[]) => void calls.push(a) } as never),
    records: new Map(),
  };
}

describe("lifecycle archive sink (fixture-only)", () => {
  it("requires an arena label when an archive is injected", () => {
    expect(() =>
      createLifecycleAuditPass({
        source: source({ 1: view() }),
        archive: new InMemoryReportArchive(),
        refresh: baseRefresh([], []),
      }),
    ).toThrow(/arena/);
  });

  it("archives each community report with accurate attribution", async () => {
    const archive = new InMemoryReportArchive();
    const calls: unknown[][] = [];
    const pass = createLifecycleAuditPass({
      source: source({ 1: view() }),
      archive,
      arena: "arena.testnet",
      refresh: baseRefresh([], calls),
    });
    const result = await pass();
    expect(result).toEqual({ checked: 1, ready: 1, errors: 0 });
    const snap = await archive.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.domain).toEqual({ arena: "arena.testnet", network: "vault-1" });
    expect(snap[0]!.attribution).toEqual({ battleId: 1, community: 0 });
    expect(snap[0]!.report.auditKind).toBe("reference_token");
    expect(snap[0]!.provenance).toBe("recorded");
  });

  it("still works and stays backward compatible when archiving is disabled", async () => {
    const reports = new AuditReportStore();
    const calls: unknown[][] = [];
    const pass = createLifecycleAuditPass({ source: source({ 1: view() }), reports, refresh: baseRefresh([], calls) });
    expect(await pass()).toEqual({ checked: 1, ready: 1, errors: 0 });
    const sent = calls[0]![2] as { evidence_hash: string };
    expect(reports.get(sent.evidence_hash)?.auditKind).toBe("reference_token");
  });

  it("surfaces a sink failure as an error, isolates other battles, and keeps on-chain submission", async () => {
    const calls: unknown[][] = [];
    const failing: ReportArchiveSink = {
      put: async () => {
        throw new Error("disk full");
      },
    };
    const pass = createLifecycleAuditPass({
      source: source({ 1: view(), 2: view() }),
      archive: failing,
      arena: "arena.testnet",
      refresh: baseRefresh([], calls),
    });
    const result = await pass();
    expect(result.checked).toBe(2); // both battles processed despite the sink failing
    expect(result.ready).toBe(2); // sink failure does not change readiness
    expect(result.errors).toBe(2); // one surfaced error per failed community
    expect(calls).toHaveLength(2); // submissions still happened for both
  });

  it("retries archiving after a failure without a new provider call while evidence is fresh", async () => {
    const queries: { chainId: string; token: string }[] = [];
    const calls: unknown[][] = [];
    let fail = true;
    const inner = new InMemoryReportArchive();
    const flaky: ReportArchiveSink = {
      put: async (i: ArchiveObservationInput): Promise<PutResult> => {
        if (fail) throw new Error("transient");
        return inner.put(i);
      },
    };
    const refresh = baseRefresh(queries, calls);
    const pass = createLifecycleAuditPass({ source: source({ 1: view() }), archive: flaky, arena: "arena.testnet", refresh });

    const first = await pass();
    expect(first.errors).toBe(1);
    expect(queries).toHaveLength(1); // one provider call to build the record

    fail = false;
    const second = await pass();
    expect(second.errors).toBe(0);
    expect(queries).toHaveLength(1); // no new provider call: the already-fresh record is re-archived
    expect(await inner.snapshot()).toHaveLength(1);
  });

  it("does not let one community's report overwrite another's history", async () => {
    const archive = new InMemoryReportArchive();
    const calls: unknown[][] = [];
    const twoCommunities: LifecycleBattleView = {
      locked: false,
      communities: [
        { chain_id: "46630", token_address: TOKEN, representation: "aa.token.testnet", custody_domain: "vault-1", reference_chain_id: REF_CHAIN, reference_address: REF_TOKEN },
        { chain_id: "46630", token_address: TOKEN, representation: "aa.token.testnet", custody_domain: "vault-2", reference_chain_id: REF_CHAIN, reference_address: REF_TOKEN },
      ],
    };
    const pass = createLifecycleAuditPass({
      source: source({ 1: twoCommunities }),
      archive,
      arena: "arena.testnet",
      refresh: baseRefresh([], calls),
    });
    await pass();
    const snap = await archive.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap.map((o) => o.attribution.community).sort((a, b) => a - b)).toEqual([0, 1]);
    expect(snap.map((o) => o.domain.network).sort()).toEqual(["vault-1", "vault-2"]);
  });

  it("skips locked battles so no report is archived for them", async () => {
    const archive = new InMemoryReportArchive();
    const pass = createLifecycleAuditPass({
      source: source({ 1: view(true) }),
      archive,
      arena: "arena.testnet",
      refresh: baseRefresh([], []),
    });
    expect(await pass()).toEqual({ checked: 0, ready: 0, errors: 0 });
    expect(await archive.snapshot()).toHaveLength(0);
  });
});
