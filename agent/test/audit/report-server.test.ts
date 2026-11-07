// FIXTURE-ONLY: the server reads a synthetic in-memory archive; no network, provider or chain.
import { describe, expect, it } from "vitest";
import { evaluateCommunity } from "../../src/audit/decision.js";
import {
  ArchiveCorruptError,
  InMemoryReportArchive,
  type ArchiveObservationInput,
  type ReportArchive,
} from "../../src/audit/report-archive.js";
import { handleReportRequest, startReportServer, type ReportServerDeps } from "../../src/audit/report-server.js";
import { buildAuditReport, type AuditReport } from "../../src/audit/report.js";
import { FIXTURE_RESOLVED, NOW, asset, goplus, lp } from "./fixtures.js";

const report = (over: Record<string, string | undefined> = {}): AuditReport =>
  buildAuditReport(evaluateCommunity({ asset, goplus: goplus(over), lp: lp("10001"), policy: FIXTURE_RESOLVED, now: NOW }));

const inp = (report: AuditReport, battleId: number): ArchiveObservationInput => ({
  report,
  attribution: { arena: "a.testnet", battleId, community: 0 },
  provenance: "fixture",
});

async function seeded(): Promise<{ deps: ReportServerDeps; pass: AuditReport; reject: AuditReport }> {
  const archive = new InMemoryReportArchive();
  const pass = report();
  const reject = report({ sell_tax: "0.2" });
  await archive.put(inp(pass, 1));
  await archive.put(inp(reject, 2));
  return { deps: { archive, now: () => NOW }, pass, reject };
}

describe("report server pure handler", () => {
  it("rejects non-GET/HEAD methods with 405", async () => {
    const { deps } = await seeded();
    for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect((await handleReportRequest(m, "/audit-reports", deps)).status).toBe(405);
    }
  });

  it("lists all observations and filters by result", async () => {
    const { deps } = await seeded();
    const all = JSON.parse((await handleReportRequest("GET", "/audit-reports", deps)).body);
    expect(all.items).toHaveLength(2);
    const onlyPass = JSON.parse((await handleReportRequest("GET", "/audit-reports?result=pass", deps)).body);
    expect(onlyPass.items).toHaveLength(1);
    expect(onlyPass.items[0].historicalResult).toBe("pass");
    expect(onlyPass.items[0].currentApproval).toBe("notEstablished");
  });

  it("returns 400 for an invalid filter", async () => {
    const { deps } = await seeded();
    expect((await handleReportRequest("GET", "/audit-reports?token=0xnothex", deps)).status).toBe(400);
    expect((await handleReportRequest("GET", "/audit-reports?result=maybe", deps)).status).toBe(400);
  });

  it("looks up observations by evidence hash and 404s on an unknown one", async () => {
    const { deps, pass } = await seeded();
    const found = await handleReportRequest("GET", `/audit-reports/${pass.evidenceHash}`, deps);
    expect(found.status).toBe(200);
    expect(JSON.parse(found.body).observations).toHaveLength(1);
    const missing = await handleReportRequest("GET", `/audit-reports/${"0".repeat(64)}`, deps);
    expect(missing.status).toBe(404);
  });

  it("returns 400, never 404 or a filesystem escape, for an invalid hash or traversal", async () => {
    const { deps } = await seeded();
    expect((await handleReportRequest("GET", "/audit-reports/not-a-hash", deps)).status).toBe(400);
    expect((await handleReportRequest("GET", "/audit-reports/..%2f..%2fetc%2fpasswd", deps)).status).toBe(400);
    expect((await handleReportRequest("GET", "/audit-reports/%2e%2e%2f", deps)).status).toBe(400);
  });

  it("renders text through the single report formatter", async () => {
    const { deps, pass } = await seeded();
    const res = await handleReportRequest("GET", `/audit-reports/${pass.evidenceHash}/text`, deps);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/plain");
    expect(res.body).toContain(`Audit report ${pass.evidenceHash}`);
    expect(res.body).toContain("Result: PASS");
  });

  it("answers HEAD like GET at the handler level", async () => {
    const { deps } = await seeded();
    expect((await handleReportRequest("HEAD", "/audit-reports", deps)).status).toBe(200);
  });

  it("returns 404 for an unknown path", async () => {
    const { deps } = await seeded();
    expect((await handleReportRequest("GET", "/something-else", deps)).status).toBe(404);
  });

  it("returns 503 when the archive is unavailable or corrupt", async () => {
    const broken: ReportArchive = {
      snapshot: async () => {
        throw new ArchiveCorruptError("boom");
      },
      put: async () => {
        throw new Error("must not be called");
      },
    };
    expect((await handleReportRequest("GET", "/audit-reports", { archive: broken, now: () => NOW })).status).toBe(503);
  });

  it("never mutates the archive or calls a writer while serving reads", async () => {
    const { deps, pass } = await seeded();
    let mutated = false;
    const guarded: ReportArchive = {
      snapshot: deps.archive.snapshot.bind(deps.archive),
      put: async (i) => {
        mutated = true;
        return deps.archive.put(i);
      },
    };
    const g = { archive: guarded, now: () => NOW };
    await handleReportRequest("GET", "/audit-reports", g);
    await handleReportRequest("GET", `/audit-reports/${pass.evidenceHash}`, g);
    await handleReportRequest("GET", `/audit-reports/${pass.evidenceHash}/text`, g);
    await handleReportRequest("POST", "/audit-reports", g);
    expect(mutated).toBe(false);
  });
});

describe("report server over real HTTP", () => {
  it("is disabled on port 0", async () => {
    const { deps } = await seeded();
    expect(await startReportServer(0, deps)).toBeUndefined();
  });

  it("serves lookup, list and HEAD on loopback with no-store, then shuts down", async () => {
    const { deps, pass } = await seeded();
    const server = await startReportServer(18093, deps, "127.0.0.1");
    try {
      const list = await fetch("http://127.0.0.1:18093/audit-reports");
      expect(list.status).toBe(200);
      expect(list.headers.get("cache-control")).toBe("no-store");
      expect((await list.json()).items).toHaveLength(2);

      const one = await fetch(`http://127.0.0.1:18093/audit-reports/${pass.evidenceHash}`);
      expect(one.status).toBe(200);

      const head = await fetch("http://127.0.0.1:18093/audit-reports", { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");

      const bad = await fetch("http://127.0.0.1:18093/audit-reports/not-a-hash");
      expect(bad.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    }
  });
});
