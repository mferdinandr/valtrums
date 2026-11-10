// FIXTURE-ONLY: synthetic GoPlus/LP evidence, an in-memory archive and a capturing logger. No network.
import { describe, expect, it } from "vitest";
import { AuditSubmitter } from "../../src/audit/approval.js";
import { evaluateCommunity, type Reason } from "../../src/audit/decision.js";
import { createLifecycleAuditPass, type LifecycleBattleView } from "../../src/audit/lifecycle-pass.js";
import { MAX_REASON_SUMMARIES, isKnownReasonCode, summarizeReasons } from "../../src/audit/reason-summary.js";
import { InMemoryReportArchive } from "../../src/audit/report-archive.js";
import { formatObservationText, queryObservations, toView } from "../../src/audit/report-query.js";
import { AuditReportStore, buildAuditReport, formatAuditReport } from "../../src/audit/report.js";
import { staticReferenceRegistry } from "../../src/reference-registry.js";
import type { Logger } from "../../src/logger.js";
import { callReadTool } from "../../src/mcp/tools.js";
import { makeDeps } from "../mcp/fixtures.js";
import { FIXTURE_RESOLVED, NOW, REF_CHAIN, REF_TOKEN, TOKEN, asset, goplus, lp, refGoplus, refLp, registry } from "./fixtures.js";

const view: LifecycleBattleView = {
  locked: false,
  communities: [{ chain_id: "46630", token_address: TOKEN, representation: "aa.token.testnet", custody_domain: "vault-1", reference_chain_id: REF_CHAIN, reference_address: REF_TOKEN }],
};

function capture() {
  const lines: { msg: string; fields: Record<string, unknown> }[] = [];
  const log: Logger = {
    info: (msg, fields) => void lines.push({ msg, fields: fields ?? {} }),
    warn: () => {},
    error: (msg, fields) => void lines.push({ msg, fields: fields ?? {} }),
  };
  return { lines, log };
}

async function runPass(over: Record<string, string | undefined>) {
  const archive = new InMemoryReportArchive();
  const { lines, log } = capture();
  const pass = createLifecycleAuditPass({
    source: { count: async () => 1, get: async () => view },
    archive,
    arena: "arena.testnet",
    provenance: "fixture",
    reports: new AuditReportStore(),
    log,
    refresh: {
      policy: FIXTURE_RESOLVED,
      registry: staticReferenceRegistry(registry),
      now: () => NOW,
      refreshAheadMs: 60_000,
      fetchGoPlus: async () => refGoplus(over),
      fetchLp: async () => refLp("10001"),
      submitter: new AuditSubmitter("arena.testnet", { call: async () => undefined } as never),
      records: new Map(),
    },
  });
  await pass();
  return { archive, line: lines.find((l) => l.msg === "audit report archived")! };
}

describe("field reasons are the same on every surface (fixtures)", () => {
  it("carries identical codes and fields in the log line, the archive and the MCP read for a rejection", async () => {
    const { archive, line } = await runPass({ is_honeypot: "1" });
    const [obs] = await archive.snapshot();
    const archived = obs!.report.reasons.map((r) => ({ code: r.code, field: r.field ?? null }));
    expect(archived).toContainEqual({ code: "critical", field: "is_honeypot" });

    const logged = (line.fields.reasons as { code: string; field: string | null }[]).map((r) => ({ code: r.code, field: r.field }));
    expect(logged).toEqual(archived);
    expect(line.fields.reasonCodes).toEqual(archived.map((r) => r.code));
    expect(line.fields.unknownReasonCodes).toEqual([]);

    const deps = await makeDeps();
    const out = (await callReadTool("inspect_audit", { battleId: 1 }, {
      ...deps,
      audits: { archive, info: { network: "near-testnet", kind: "fixture", name: "archive" } },
    })) as unknown as { data: { observations: ReturnType<typeof toView>[] } };
    const o = out.data.observations[0]!;
    expect(o.reasonSummary.reasons.map((r) => ({ code: r.code, field: r.field }))).toEqual(archived);
    expect(o.report.reasons.map((r) => ({ code: r.code, field: r.field ?? null }))).toEqual(archived);
    // The log line carries codes and fields only, never the free-text message.
    expect(JSON.stringify(line)).not.toContain(obs!.report.reasons[0]!.message);
  });

  it("carries identical codes for a Pending decision from an unknown required field", async () => {
    const { archive, line } = await runPass({ sell_tax: "" });
    const [obs] = await archive.snapshot();
    expect(obs!.report.result).toBe("pending");
    const read = queryObservations(await archive.snapshot(), { battleId: 1 }, NOW).items[0]!;
    const codes = obs!.report.reasons.map((r) => r.code);
    expect(codes).toContain("unknown_field");
    expect(line.fields.reasonCodes).toEqual(codes);
    expect(read.reasonSummary.reasons.map((r) => r.code)).toEqual(codes);
  });
});

describe("unknown reason codes are surfaced, never dropped (fixtures)", () => {
  const extra: Reason[] = [{ code: "brand_new_code", field: "some_flag", message: "fixture message" }];
  const record = evaluateCommunity({ asset, goplus: goplus(), lp: lp("10001"), policy: FIXTURE_RESOLVED, now: NOW });
  const report = buildAuditReport({ ...record, reasons: [...record.reasons, ...extra] });

  it("flags the code as unknown in the summary, the read model and the text rendering", () => {
    const s = summarizeReasons(report.reasons);
    expect(s.reasons).toEqual([{ code: "brand_new_code", field: "some_flag", known: false }]);
    const v = toView(
      {
        observationId: "x",
        seq: 1,
        archivedAt: NOW.toISOString(),
        provenance: "fixture",
        domain: { arena: "a", custodyDomain: "vault-1" },
        attribution: { battleId: 1, community: 0 },
        report,
      } as never,
      NOW,
    );
    expect(v.reasonSummary.reasons[0]).toMatchObject({ code: "brand_new_code", known: false });
    expect(formatAuditReport(report)).toContain("[brand_new_code] some_flag: fixture message (unknown reason code)");
    expect(formatObservationText(v)).toContain("brand_new_code");
  });

  it("recognizes the codes this build emits and the source_/lp_ families", () => {
    for (const c of ["critical", "unknown_field", "tax_above_limit", "source_rate_limited", "lp_at_or_below_threshold"]) {
      expect(isKnownReasonCode(c)).toBe(true);
    }
    for (const c of ["", "source_", "lp_", "mystery"]) expect(isKnownReasonCode(c)).toBe(false);
  });

  it("bounds the list and reports truncation instead of dropping silently", () => {
    const many: Reason[] = Array.from({ length: MAX_REASON_SUMMARIES + 3 }, (_, i) => ({ code: `c${i}`, message: "m" }));
    const s = summarizeReasons(many);
    expect(s.reasons).toHaveLength(MAX_REASON_SUMMARIES);
    expect(s.truncated).toBe(true);
    expect(summarizeReasons([{ code: "x".repeat(500), message: "m" }]).reasons[0]!.code.length).toBeLessThan(200);
  });
});
