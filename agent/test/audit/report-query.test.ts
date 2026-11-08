// FIXTURE-ONLY: observations are built from synthetic evidence; freshness uses an injected clock.
import { describe, expect, it } from "vitest";
import { evaluateCommunity } from "../../src/audit/decision.js";
import {
  InMemoryReportArchive,
  type ArchiveObservationInput,
  type ArchivedObservation,
} from "../../src/audit/report-archive.js";
import {
  CURRENT_APPROVAL,
  freshnessOf,
  normalizeQuery,
  queryObservations,
  QueryValidationError,
  toView,
} from "../../src/audit/report-query.js";
import { buildAuditReport, type AuditReport } from "../../src/audit/report.js";
import { resolveReference } from "../../src/audit/reference.js";
import { FIXTURE_RESOLVED, NOW, REF_CHAIN, REF_TOKEN, asset, goplus, lp, refGoplus, refLp, registry } from "./fixtures.js";

const PASS_EXPIRY = "2026-11-07T12:09:00.000Z"; // QUERIED 11:59:00 + 600s TTL

const report = (over: Record<string, string | undefined> = {}, now = NOW): AuditReport =>
  buildAuditReport(evaluateCommunity({ asset, goplus: goplus(over), lp: lp("10001"), policy: FIXTURE_RESOLVED, now }));

function referenceReport(): AuditReport {
  const m = resolveReference(asset, registry);
  if (m.kind !== "mapped") throw new Error("expected mapping");
  return buildAuditReport(
    evaluateCommunity({ asset: { ...asset, reference: m.reference }, goplus: refGoplus(), lp: refLp("10001"), policy: FIXTURE_RESOLVED, now: NOW }),
  );
}

async function store(inputs: ArchiveObservationInput[]): Promise<ArchivedObservation[]> {
  const a = new InMemoryReportArchive();
  for (const i of inputs) await a.put(i);
  return a.snapshot();
}

const inp = (report: AuditReport, attribution: { arena: string; battleId: number; community: number }): ArchiveObservationInput => ({
  report,
  attribution,
  provenance: "fixture",
});

describe("freshness is distinct from the historical result", () => {
  it("is fresh strictly before expiry and expired at or after it", () => {
    const pass = report();
    expect(pass.result).toBe("pass");
    expect(pass.times.expiresAt).toBe(PASS_EXPIRY);
    expect(freshnessOf(pass, new Date("2026-11-07T12:08:59.999Z"))).toBe("fresh");
    expect(freshnessOf(pass, new Date(PASS_EXPIRY))).toBe("expired");
    expect(freshnessOf(pass, new Date("2026-11-07T12:09:00.001Z"))).toBe("expired");
  });

  it("is not_applicable for a non-pass or a null/malformed expiry", () => {
    const pending = report({ sell_tax: "" });
    expect(pending.result).toBe("pending");
    expect(pending.times.expiresAt).toBeNull();
    expect(freshnessOf(pending, NOW)).toBe("not_applicable");

    const bogus = { ...report(), times: { ...report().times, expiresAt: "not-a-date" } } as AuditReport;
    expect(freshnessOf(bogus, NOW)).toBe("not_applicable");
  });

  it("never rewrites a stored pass and never asserts current approval", () => {
    const v = toView(mkObs(report(), { arena: "a", battleId: 1, community: 0 }), new Date("2026-11-08T00:00:00.000Z"));
    expect(v.historicalResult).toBe("pass"); // immutable
    expect(v.freshness).toBe("expired");
    expect(v.currentApproval).toBe(CURRENT_APPROVAL);
    expect(v.currentApproval).toBe("notEstablished");
  });
});

// Minimal ArchivedObservation builder for pure toView tests (no persistence needed).
function mkObs(report: AuditReport, attribution: { arena: string; battleId: number; community: number }): ArchivedObservation {
  return {
    observationId: "x".repeat(64),
    seq: 1,
    archivedAt: NOW.toISOString(),
    reportSchemaVersion: "audit-report-v1",
    provenance: "fixture",
    domain: { arena: attribution.arena, custodyDomain: report.asset.custodyDomain },
    attribution: { battleId: attribution.battleId, community: attribution.community },
    report,
  };
}

describe("reference-token observation keeps the mainnet-vs-mock distinction", () => {
  it("states the reference attestation and limitation in the view", async () => {
    const snap = await store([inp(referenceReport(), { arena: "a.testnet", battleId: 1, community: 0 })]);
    const v = toView(snap[0]!, NOW);
    expect(v.report.auditKind).toBe("reference_token");
    expect(v.report.reference).toMatchObject({ chainId: REF_CHAIN, token: REF_TOKEN });
    expect(v.limitations.join("\n")).toContain("was not itself audited");
    expect(v.limitations.join("\n")).toContain(`mainnet reference chain ${REF_CHAIN}`);
    expect(v.limitations.join("\n")).toContain("Historical observation only");
  });
});

describe("backend filters and pagination", () => {
  it("combines filters and returns only matching observations", async () => {
    const snap = await store([
      inp(report(), { arena: "alpha", battleId: 1, community: 0 }),
      inp(report({ sell_tax: "0.2" }), { arena: "alpha", battleId: 1, community: 1 }), // reject
      inp(report(), { arena: "beta", battleId: 2, community: 0 }),
    ]);
    const onlyAlphaPass = queryObservations(snap, { arena: "alpha", result: "pass" }, NOW);
    expect(onlyAlphaPass.items).toHaveLength(1);
    expect(onlyAlphaPass.items[0]!.domain.arena).toBe("alpha");
    expect(onlyAlphaPass.items[0]!.historicalResult).toBe("pass");

    const byToken = queryObservations(snap, { token: asset.token, battleId: 2 }, NOW);
    expect(byToken.items).toHaveLength(1);
    expect(byToken.items[0]!.attribution.battleId).toBe(2);
  });

  it("paginates with a stable cursor and does not skip new inserts", async () => {
    const a = new InMemoryReportArchive();
    for (let c = 0; c < 5; c++) await a.put(inp(report(), { arena: "a", battleId: 1, community: c }));

    const p1 = queryObservations(await a.snapshot(), { pageSize: 2 }, NOW);
    expect(p1.items.map((i) => i.seq)).toEqual([1, 2]);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = queryObservations(await a.snapshot(), { pageSize: 2, cursor: p1.nextCursor! }, NOW);
    expect(p2.items.map((i) => i.seq)).toEqual([3, 4]);

    // A new observation is inserted between pages; it appends at the tail (higher seq).
    await a.put(inp(report(), { arena: "a", battleId: 1, community: 99 }));
    const p3 = queryObservations(await a.snapshot(), { pageSize: 2, cursor: p2.nextCursor! }, NOW);
    expect(p3.items.map((i) => i.seq)).toEqual([5, 6]); // 5 not skipped, 6 is the new insert
    expect(p3.nextCursor).toBeNull();
  });

  it("clamps page size to the maximum", () => {
    expect(normalizeQuery({ pageSize: 10_000 }).pageSize).toBe(100);
    expect(normalizeQuery({}).pageSize).toBe(20);
  });

  it("rejects invalid query parameters", () => {
    expect(() => normalizeQuery({ token: "0xnothex" })).toThrow(QueryValidationError);
    expect(() => normalizeQuery({ result: "maybe" as never })).toThrow(QueryValidationError);
    expect(() => normalizeQuery({ freshness: "stale" as never })).toThrow(QueryValidationError);
    expect(() => normalizeQuery({ battleId: -1 })).toThrow(QueryValidationError);
    expect(() => normalizeQuery({ cursor: "!!!notbase64number" })).toThrow(QueryValidationError);
  });

  it("filters by freshness category against the clock", async () => {
    const snap = await store([inp(report(), { arena: "a", battleId: 1, community: 0 })]);
    expect(queryObservations(snap, { freshness: "fresh" }, NOW).items).toHaveLength(1);
    expect(queryObservations(snap, { freshness: "expired" }, NOW).items).toHaveLength(0);
    expect(queryObservations(snap, { freshness: "expired" }, new Date(PASS_EXPIRY)).items).toHaveLength(1);
  });

  it("preserves exact large decimal strings through the view", async () => {
    const big = buildAuditReport(
      evaluateCommunity({ asset, goplus: goplus(), lp: lp("99999999999999999999"), policy: FIXTURE_RESOLVED, now: NOW }),
    );
    const snap = await store([inp(big, { arena: "a", battleId: 1, community: 0 })]);
    expect(toView(snap[0]!, NOW).report.liquidity.headlineUsd).toBe("99999999999999999999");
  });
});
