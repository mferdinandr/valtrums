// FIXTURE-ONLY wiring seam: producer (lifecycle pass + JsonFileReportArchive from the entry-point config)
// -> on-disk archive -> restart -> inspect_audit consumer. Providers are injected fixtures; no network.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditSubmitter } from "../../src/audit/approval.js";
import { loadReportArchiveConfig, resolveArchivePath } from "../../src/audit/config.js";
import { createLifecycleAuditPass, type LifecycleBattleView } from "../../src/audit/lifecycle-pass.js";
import { ArchiveCorruptError, JsonFileReportArchive } from "../../src/audit/report-archive.js";
import { depsFromEnv } from "../../src/mcp/cli.js";
import { callReadTool } from "../../src/mcp/tools.js";
import { staticReferenceRegistry } from "../../src/reference-registry.js";
import { makeDeps } from "../mcp/fixtures.js";
import { FIXTURE_RESOLVED, NOW, REF_CHAIN, REF_TOKEN, TOKEN, refGoplus, refLp, registry } from "./fixtures.js";

const ARENA = "arena.testnet";
const view: LifecycleBattleView = {
  locked: false,
  communities: [
    { chain_id: "46630", token_address: TOKEN, representation: "aa.token.testnet", custody_domain: "vault-1", reference_chain_id: REF_CHAIN, reference_address: REF_TOKEN },
  ],
};

function pass(archive: { put: JsonFileReportArchive["put"] }, arena = ARENA, queries: unknown[] = []) {
  return createLifecycleAuditPass({
    source: { count: async () => 1, get: async () => view },
    archive,
    arena,
    refresh: {
      policy: FIXTURE_RESOLVED,
      registry: staticReferenceRegistry(registry),
      now: () => NOW,
      refreshAheadMs: 60_000,
      fetchGoPlus: async (q) => (queries.push(q), refGoplus()),
      fetchLp: async () => refLp("10001"),
      submitter: new AuditSubmitter(ARENA, { call: async () => undefined } as never),
      records: new Map(),
    },
  });
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "archive-handoff-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const consumerEnv = (extra: Record<string, string | undefined>) => ({
  READ_SESSION_SECRET: "ab".repeat(32),
  READ_SESSION_RECIPIENT: "valtrum-read.test",
  ARENA_CONTRACT_ID: ARENA,
  ...extra,
});

async function inspect(path: string, nowMs: number, arena: string | undefined = ARENA) {
  const base = await makeDeps();
  return callReadTool("inspect_audit", { battleId: 1 }, {
    ...base,
    now: () => nowMs,
    audits: { archive: new JsonFileReportArchive(path), arena, info: { network: "near-testnet", kind: "recorded", name: "audit-report-archive" } },
  });
}

describe("archive config handoff", () => {
  it("treats the producer and consumer variable names as aliases and rejects a split", () => {
    expect(resolveArchivePath({})).toBeUndefined();
    expect(resolveArchivePath({ AUDIT_REPORT_ARCHIVE_PATH: "/a.json" })).toBe("/a.json");
    expect(resolveArchivePath({ AUDIT_ARCHIVE_PATH: "/a.json" })).toBe("/a.json");
    expect(resolveArchivePath({ AUDIT_ARCHIVE_PATH: "/a.json", AUDIT_REPORT_ARCHIVE_PATH: " /a.json " })).toBe("/a.json");
    expect(() => resolveArchivePath({ AUDIT_ARCHIVE_PATH: "/a.json", AUDIT_REPORT_ARCHIVE_PATH: "/b.json" })).toThrow(/aliases/);
    // The legacy consumer name now also drives the producer, so deployed config keeps one shared file.
    expect(loadReportArchiveConfig({ AUDIT_REPORT_ARCHIVE_ENABLED: "true", AUDIT_ARCHIVE_PATH: "/legacy.json" }, true)).toEqual({ path: "/legacy.json" });
  });

  it("enabling the archive without the audit pass still fails; disabled stays backward compatible", () => {
    expect(() => loadReportArchiveConfig({ AUDIT_REPORT_ARCHIVE_ENABLED: "true" }, false)).toThrow(/AUDIT_ENABLED/);
    expect(loadReportArchiveConfig({ AUDIT_ARCHIVE_PATH: "/x.json" }, true)).toBeNull();
  });

  it("the consumer reads the producer's file from either name and always labels the source recorded", () => {
    for (const env of [{ AUDIT_REPORT_ARCHIVE_PATH: join(dir, "a.json") }, { AUDIT_ARCHIVE_PATH: join(dir, "a.json") }, { AUDIT_REPORT_ARCHIVE_ENABLED: "true" }]) {
      const audits = depsFromEnv(consumerEnv(env)).audits;
      expect(audits?.info).toEqual({ network: "near-testnet", kind: "recorded", name: "audit-report-archive" });
      expect(audits?.arena).toBe(ARENA);
    }
    expect(depsFromEnv(consumerEnv({})).audits).toBeUndefined();
    // Flags and service names cannot relabel recorded evidence as live.
    expect(depsFromEnv(consumerEnv({ AUDIT_ARCHIVE_PATH: join(dir, "a.json"), AUDIT_PROVENANCE: "live", AUDIT_LIVE: "true" })).audits?.info.kind).toBe("recorded");
  });
});

describe("producer -> archive -> restart -> inspect_audit", () => {
  it("persists attributed evidence that a fresh archive instance and the consumer read back", async () => {
    const path = join(dir, "state", "archive.json");
    const queries: unknown[] = [];
    expect(await pass(new JsonFileReportArchive(path), ARENA, queries)()).toEqual({ checked: 1, ready: 1, errors: 0 });

    // "Restart": a brand-new archive instance over the same path, and no producer state.
    const out = await inspect(path, NOW.getTime());
    const [o] = (out.data as { observations: any[] }).observations;
    expect(out.source.kind).toBe("recorded");
    expect(o.provenance).toBe("recorded");
    expect(o.domain).toEqual({ arena: ARENA, custodyDomain: "vault-1" });
    expect(o.attribution).toEqual({ battleId: 1, community: 0 });
    expect(o.historicalResult).toBe("pass");
    expect(o.freshness).toBe("fresh");
    expect(o.currentApproval).toBe("notEstablished");
    expect(o.report.policy.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(o.report.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    // Reference-token identity versus the testnet mock is explicit.
    expect(o.report.auditKind).toBe("reference_token");
    expect(o.report.reference.token).toBe(REF_TOKEN);
    expect(o.report.asset.token).toBe(TOKEN);
    expect(o.limitations.join(" ")).toMatch(/mock token .* was not itself audited/);
    expect(out.limitations.join(" ")).toMatch(/does not establish current approval/);
    expect(queries).toHaveLength(1);
  });

  it("separates a missing archive, an expired historical pass and an unestablished current approval", async () => {
    const path = join(dir, "archive.json");
    const missing = await inspect(path, NOW.getTime());
    expect((missing.data as { observations: unknown[] }).observations).toEqual([]);
    expect(missing.limitations.join(" ")).toMatch(/no archived observation/);

    await pass(new JsonFileReportArchive(path))();
    const expired = await inspect(path, NOW.getTime() + 60 * 60_000);
    const [o] = (expired.data as { observations: any[] }).observations;
    expect(o.historicalResult).toBe("pass"); // the history is not rewritten ...
    expect(o.freshness).toBe("expired"); // ... but it is visibly stale ...
    expect(o.currentApproval).toBe("notEstablished"); // ... and never a current approval
    expect(expired.limitations.join(" ")).not.toMatch(/no archived observation/);
  });

  it("does not return observations attributed to another arena", async () => {
    const path = join(dir, "archive.json");
    await pass(new JsonFileReportArchive(path), "other-arena.testnet")();
    expect(((await inspect(path, NOW.getTime())).data as { observations: unknown[] }).observations).toEqual([]);
    expect(((await inspect(path, NOW.getTime(), "other-arena.testnet")).data as { observations: unknown[] }).observations).toHaveLength(1);
  });
});

describe("failure visibility and retry", () => {
  it("surfaces an unwritable archive, then retries to success without a new provider call", async () => {
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory");
    const path = join(blocker, "archive.json"); // parent is a file: every write fails
    const queries: unknown[] = [];
    const p = pass(new JsonFileReportArchive(path), ARENA, queries);
    expect(await p()).toEqual({ checked: 1, ready: 1, errors: 1 }); // visible, not discarded; readiness unaffected

    await rm(blocker);
    expect(await p()).toEqual({ checked: 1, ready: 1, errors: 0 });
    expect(queries).toHaveLength(1);
    expect(((await inspect(path, NOW.getTime())).data as { observations: unknown[] }).observations).toHaveLength(1);
  });

  it("reports a corrupt archive to producer and consumer instead of resetting it", async () => {
    const path = join(dir, "archive.json");
    await writeFile(path, "{ not json");
    expect(await pass(new JsonFileReportArchive(path))()).toEqual({ checked: 1, ready: 1, errors: 1 });
    await expect(inspect(path, NOW.getTime())).rejects.toBeInstanceOf(ArchiveCorruptError);
  });
});
