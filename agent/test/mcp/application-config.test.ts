import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadApplicationReads } from "../../src/mcp/application-config.js";
import { namespaceOf, type Deployment } from "../../src/mcp/application-contract.js";
import { handleApplicationRead } from "../../src/mcp/application.js";
import { JsonFileReportArchive } from "../../src/audit/report-archive.js";
import { buildAuditReport } from "../../src/audit/report.js";
import { evaluateCommunity } from "../../src/audit/decision.js";
import { FIXTURE_RESOLVED, NOW, asset, goplus, lp } from "../audit/fixtures.js";
import { battle } from "./fixtures.js";

const cap = { enabled: true, reasons: ["recorded source inspection"] };
const d: Deployment = { deploymentId: "arena-recorded-v1", network: "near-testnet", arenaContract: "arena.testnet", protocol: "lifecycle-v2", adapter: "fixture",
  companions: { registry: "arena.testnet", payout: null, backing: [] }, abi: { version: "v1", evidence: "fixture", codeHash: null },
  capabilities: { battles: cap, detail: cap, assets: cap, audits: cap } };

describe("application entry-point configuration (fixtures only)", () => {
  it("starts disabled without a manifest; refuses missing/invalid configuration instead of fallback", async () => {
    expect(await loadApplicationReads({}, vi.fn())).toBeUndefined();
    await expect(loadApplicationReads({ ARENA_APPLICATION_MANIFEST_PATH: "/missing/manifest" }, vi.fn())).rejects.toThrow();
  });
  it("reads a dedicated fixture file and producer archive after restart; missing archive is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "application-read-"));
    try {
      const manifest = join(dir, "manifest.json"); const fixture = join(dir, "fixture.json"); const archivePath = join(dir, "archive.json");
      await writeFile(manifest, JSON.stringify([d]));
      await writeFile(fixture, JSON.stringify({ battles: [{ id: "1", battle: battle(), round: null }], registry: [] }));
      const env = { ARENA_APPLICATION_MANIFEST_PATH: manifest, ARENA_APPLICATION_FIXTURE_PATH: fixture,
        AUDIT_ARCHIVE_PATH: archivePath, ARENA_APPLICATION_AUDIT_SCOPE: JSON.stringify(namespaceOf(d)) };
      const views = vi.fn();
      const first = await loadApplicationReads(env, views);
      const query = new URLSearchParams({ deployment: d.deploymentId, protocol: d.protocol });
      expect((await handleApplicationRead("GET", "battles", query, first)).status).toBe(200);
      expect((await handleApplicationRead("GET", "battles/1/audits", query, first)).status).toBe(503);
      const archive = new JsonFileReportArchive(archivePath);
      await archive.put({ provenance: "fixture", attribution: { arena: d.arenaContract, battleId: 1, community: 0 },
        report: buildAuditReport(evaluateCommunity({ asset, goplus: goplus(), lp: lp("10001"), policy: FIXTURE_RESOLVED, now: NOW })) });
      const restarted = await loadApplicationReads(env, views);
      const out = await handleApplicationRead("GET", "battles/1/audits", query, restarted);
      expect(out.status).toBe(200); expect(JSON.parse(out.body).data.items[0].provenance).toBe("fixture");
      expect(views).not.toHaveBeenCalled();
      const unbound = await loadApplicationReads({ ...env, ARENA_APPLICATION_AUDIT_SCOPE: undefined }, views);
      expect((await handleApplicationRead("GET", "battles/1/audits", query, unbound)).status).toBe(422);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
