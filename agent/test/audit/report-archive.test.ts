// FIXTURE-ONLY: observations are built from synthetic evidence; no network or live provider.
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateCommunity } from "../../src/audit/decision.js";
import {
  ARCHIVE_SCHEMA,
  ArchiveConflictError,
  ArchiveCorruptError,
  ArchiveValidationError,
  InMemoryReportArchive,
  JsonFileReportArchive,
  REPORT_SCHEMA_VERSION,
  type ArchiveObservationInput,
} from "../../src/audit/report-archive.js";
import { buildAuditReport, type AuditReport } from "../../src/audit/report.js";
import { FIXTURE_RESOLVED, NOW, asset, goplus, lp } from "./fixtures.js";

const report = (over: Record<string, string | undefined> = {}, now = NOW): AuditReport =>
  buildAuditReport(evaluateCommunity({ asset, goplus: goplus(over), lp: lp("10001"), policy: FIXTURE_RESOLVED, now }));

const input = (report: AuditReport, attribution = { arena: "a.testnet", battleId: 1, community: 0 }): ArchiveObservationInput => ({
  report,
  attribution,
  provenance: "fixture",
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "report-archive-"));
});
afterEach(async () => {
  await chmod(dir, 0o755).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

describe("JsonFileReportArchive persistence", () => {
  it("persists observations identically across a new instance and restart", async () => {
    const path = join(dir, "state", "archive.json");
    const r = report();
    const first = await new JsonFileReportArchive(path).put(input(r));
    expect(first.created).toBe(true);

    const reopened = await new JsonFileReportArchive(path).snapshot();
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.report).toEqual(r);
    expect(reopened[0]!.observationId).toBe(first.observation.observationId);
    expect(reopened[0]!.domain).toEqual({ arena: "a.testnet", network: asset.custodyDomain });
    expect(reopened[0]!.attribution).toEqual({ battleId: 1, community: 0 });
  });

  it("is idempotent for an identical observation retry", async () => {
    const a = new JsonFileReportArchive(join(dir, "archive.json"));
    const r = report();
    const first = await a.put(input(r));
    const second = await a.put(input(r));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.observation.observationId).toBe(first.observation.observationId);
    expect(second.observation.archivedAt).toBe(first.observation.archivedAt);
    expect(await a.snapshot()).toHaveLength(1);
  });

  it("preserves differing legitimate evaluations of the same evidence as separate observations", async () => {
    const a = new JsonFileReportArchive(join(dir, "archive.json"));
    const fresh = report({}, NOW); // pass, decided at NOW
    const stale = report({}, new Date(NOW.getTime() + 11 * 60_000)); // same evidence, later decision -> stale -> pending
    expect(fresh.evidenceHash).toBe(stale.evidenceHash);
    expect(fresh.result).toBe("pass");
    expect(stale.result).toBe("pending");
    await a.put(input(fresh));
    await a.put(input(stale));
    const snap = await a.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap.map((o) => o.report.result).sort()).toEqual(["pass", "pending"]);
    expect(new Set(snap.map((o) => o.observationId)).size).toBe(2);
  });

  it("rejects a conflicting observation id rather than overwriting history", async () => {
    const a = new JsonFileReportArchive(join(dir, "archive.json"), { hashFn: () => "COLLIDE" });
    const r1 = report();
    const r2 = report({ sell_tax: "0.01" }); // genuinely different report, forced to the same id
    await a.put(input(r1));
    await expect(a.put(input(r2))).rejects.toBeInstanceOf(ArchiveConflictError);
    // Identical content under the same forced id is still idempotent, and history is intact.
    expect((await a.put(input(r1))).created).toBe(false);
    const snap = await a.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.report.evidenceHash).toBe(r1.evidenceHash);
  });

  it("isolates associations when two arenas/battles share the same evidence", async () => {
    const a = new JsonFileReportArchive(join(dir, "archive.json"));
    const r = report();
    await a.put(input(r, { arena: "alpha.testnet", battleId: 7, community: 0 }));
    await a.put(input(r, { arena: "beta.testnet", battleId: 9, community: 3 }));
    const snap = await a.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap.every((o) => o.report.evidenceHash === r.evidenceHash)).toBe(true);
    expect(snap.map((o) => o.domain.arena).sort()).toEqual(["alpha.testnet", "beta.testnet"]);
    expect(snap.map((o) => o.attribution.battleId).sort((x, y) => x - y)).toEqual([7, 9]);
  });

  it("keeps every observation from concurrent writers on one instance", async () => {
    const a = new JsonFileReportArchive(join(dir, "archive.json"));
    const r = report();
    await Promise.all([0, 1, 2, 3].map((c) => a.put(input(r, { arena: "a.testnet", battleId: 1, community: c }))));
    expect(await a.snapshot()).toHaveLength(4);
  });

  it("keeps every observation from two competing writer instances", async () => {
    const path = join(dir, "archive.json");
    const w1 = new JsonFileReportArchive(path);
    const w2 = new JsonFileReportArchive(path);
    const r = report();
    await Promise.all([
      w1.put(input(r, { arena: "a.testnet", battleId: 1, community: 0 })),
      w2.put(input(r, { arena: "a.testnet", battleId: 1, community: 1 })),
      w1.put(input(r, { arena: "a.testnet", battleId: 2, community: 0 })),
      w2.put(input(r, { arena: "a.testnet", battleId: 2, community: 1 })),
    ]);
    expect(await new JsonFileReportArchive(path).snapshot()).toHaveLength(4);
  });

  it("preserves committed state when a write fails", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses perms
    const a = new JsonFileReportArchive(join(dir, "archive.json"));
    await a.put(input(report()));
    await chmod(dir, 0o555); // read + traverse, no create: the lock and temp file cannot be written
    await expect(a.put(input(report({ buy_tax: "0.01" })))).rejects.toBeTruthy();
    await chmod(dir, 0o755);
    const snap = await a.snapshot();
    expect(snap).toHaveLength(1); // the first, committed observation survives
  });
});

describe("JsonFileReportArchive refuses corrupt or unsupported state", () => {
  it("throws on invalid JSON rather than resetting to empty", async () => {
    const path = join(dir, "archive.json");
    await writeFile(path, "{not json", "utf8");
    await expect(new JsonFileReportArchive(path).snapshot()).rejects.toBeInstanceOf(ArchiveCorruptError);
  });

  it("throws on an unsupported archive schema", async () => {
    const path = join(dir, "archive.json");
    await writeFile(path, JSON.stringify({ schema: "something-else", nextSeq: 1, observations: [] }), "utf8");
    await expect(new JsonFileReportArchive(path).snapshot()).rejects.toBeInstanceOf(ArchiveCorruptError);
  });

  it("throws on an unsupported report schema version in a stored observation", async () => {
    const path = join(dir, "archive.json");
    const a = new JsonFileReportArchive(path);
    await a.put(input(report()));
    const parsed = JSON.parse(await readFile(path, "utf8"));
    parsed.observations[0].reportSchemaVersion = "audit-report-v99";
    await writeFile(path, JSON.stringify(parsed), "utf8");
    await expect(new JsonFileReportArchive(path).snapshot()).rejects.toBeInstanceOf(ArchiveCorruptError);
  });

  it("throws when a stored observation id does not match its contents", async () => {
    const path = join(dir, "archive.json");
    const a = new JsonFileReportArchive(path);
    await a.put(input(report()));
    const parsed = JSON.parse(await readFile(path, "utf8"));
    parsed.observations[0].report.result = "reject"; // tamper with the body, keep the old id
    await writeFile(path, JSON.stringify(parsed), "utf8");
    await expect(new JsonFileReportArchive(path).snapshot()).rejects.toBeInstanceOf(ArchiveCorruptError);
  });

  it("reports an empty archive for a missing file without creating it", async () => {
    expect(await new JsonFileReportArchive(join(dir, "nope", "archive.json")).snapshot()).toEqual([]);
  });
});

describe("observation validation", () => {
  const archive = () => new InMemoryReportArchive();

  it("rejects a malformed evidence hash", async () => {
    const r = { ...report(), evidenceHash: "not-hex" };
    await expect(archive().put(input(r))).rejects.toBeInstanceOf(ArchiveValidationError);
  });

  it("rejects a malformed decided timestamp", async () => {
    const base = report();
    const r = { ...base, times: { ...base.times, decidedAt: "nope" } };
    await expect(archive().put(input(r))).rejects.toBeInstanceOf(ArchiveValidationError);
  });

  it("rejects an empty arena label", async () => {
    await expect(archive().put(input(report(), { arena: "", battleId: 1, community: 0 }))).rejects.toBeInstanceOf(
      ArchiveValidationError,
    );
  });

  it("rejects an overlong report", async () => {
    const base = report();
    const huge = { ...base, reasons: [{ code: "x", message: "y".repeat(70_000) }] };
    await expect(archive().put(input(huge))).rejects.toBeInstanceOf(ArchiveValidationError);
  });

  it("preserves exact decimal strings without numeric conversion", async () => {
    const a = archive();
    const r = report({ buy_tax: "0.0125" });
    await a.put(input(r));
    const stored = (await a.snapshot())[0]!.report;
    expect(stored.taxes.find((t) => t.field === "buy_tax")?.percent).toBe("1.25");
    expect(stored.liquidity.headlineUsd).toBe("10001");
  });

  it("writes a header with the expected schema and report version", async () => {
    const path = join(dir, "archive.json");
    await new JsonFileReportArchive(path).put(input(report()));
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.schema).toBe(ARCHIVE_SCHEMA);
    expect(parsed.observations[0].reportSchemaVersion).toBe(REPORT_SCHEMA_VERSION);
  });
});
