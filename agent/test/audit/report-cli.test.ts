// FIXTURE-ONLY: the CLI seeds synthetic demo observations; the end-to-end demo uses a temp archive.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditSubmitter } from "../../src/audit/approval.js";
import { createLifecycleAuditPass, type LifecycleBattleView } from "../../src/audit/lifecycle-pass.js";
import { JsonFileReportArchive } from "../../src/audit/report-archive.js";
import { buildDemoObservations, runCli, type CliIo } from "../../src/audit/report-cli.js";
import { startReportServer } from "../../src/audit/report-server.js";
import { FIXTURE_RESOLVED, NOW, REF_CHAIN, REF_TOKEN, TOKEN, refGoplus, refLp, registry } from "./fixtures.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "report-cli-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

describe("report CLI", () => {
  it("builds three valid labelled demo observations", () => {
    const inputs = buildDemoObservations();
    expect(inputs).toHaveLength(3);
    expect(inputs.map((i) => i.report.result).sort()).toEqual(["pass", "pass", "reject"]);
    expect(inputs.every((i) => i.provenance === "fixture")).toBe(true);
    expect(inputs.find((i) => i.report.auditKind === "reference_token")).toBeDefined();
  });

  it("seeds demo data idempotently and lists it", async () => {
    const c = capture();
    expect(await runCli(["seed-demo", "--dir", dir], {}, c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("seeded 3 new demo observation(s)");

    // Re-seeding is idempotent (no new observations).
    const c2 = capture();
    await runCli(["seed-demo", "--dir", dir], {}, c2.io);
    expect(c2.out.join("\n")).toContain("seeded 0 new demo observation(s)");

    const c3 = capture();
    await runCli(["list", "--dir", dir], {}, c3.io);
    const listed = JSON.parse(c3.out.join("\n"));
    expect(listed.items).toHaveLength(3);
  });

  it("gets a report by evidence hash as JSON and as text", async () => {
    await runCli(["seed-demo", "--dir", dir], {}, capture().io);
    const hash = buildDemoObservations()[0]!.report.evidenceHash;

    const asJson = capture();
    expect(await runCli(["get", hash, "--dir", dir], {}, asJson.io)).toBe(0);
    expect(JSON.parse(asJson.out.join("\n")).observations[0].report.evidenceHash).toBe(hash);

    const asText = capture();
    await runCli(["get", hash, "--dir", dir, "--text"], {}, asText.io);
    expect(asText.out.join("\n")).toContain(`Audit report ${hash}`);
    expect(asText.out.join("\n")).toContain("Provenance: fixture");
    expect(asText.out.join("\n")).toContain("Arena: demo.arena.testnet");
    expect(asText.out.join("\n")).toContain("Battle: 1; community: 0");
    expect(asText.out.join("\n")).toContain("Observation: ");
    expect(asText.out.join("\n")).toContain("Current approval: notEstablished");
    expect(asText.out.join("\n")).toContain("Historical observation only: not current lock approval");
  });

  it("labels expired fixture history and preserves reference-token limitations in CLI text", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T00:00:00.000Z"));
    try {
      await runCli(["seed-demo", "--dir", dir], {}, capture().io);
      const reference = buildDemoObservations().find((o) => o.report.auditKind === "reference_token")!;
      const c = capture();
      expect(await runCli(["get", reference.report.evidenceHash, "--dir", dir, "--text"], {}, c.io)).toBe(0);
      const text = c.out.join("\n");
      expect(text).toContain("Historical result: PASS");
      expect(text).toContain("Freshness: expired");
      expect(text).toContain("Provenance: fixture");
      expect(text).toContain("Current approval: notEstablished");
      expect(text).toContain("was not itself audited");
      expect(text).toContain("mainnet reference chain 4663");
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters the list by result", async () => {
    await runCli(["seed-demo", "--dir", dir], {}, capture().io);
    const c = capture();
    await runCli(["list", "--dir", dir, "--result", "reject"], {}, c.io);
    const listed = JSON.parse(c.out.join("\n"));
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].historicalResult).toBe("reject");
  });

  it("filters the list by custody domain", async () => {
    await runCli(["seed-demo", "--dir", dir], {}, capture().io);
    const matched = capture();
    await runCli(["list", "--dir", dir, "--custodyDomain", "demo-vault"], {}, matched.io);
    const inDomain = JSON.parse(matched.out.join("\n"));
    expect(inDomain.items).toHaveLength(3);
    expect(inDomain.items.every((i: { domain: { custodyDomain: string } }) => i.domain.custodyDomain === "demo-vault")).toBe(true);

    const absent = capture();
    await runCli(["list", "--dir", dir, "--custodyDomain", "no-such-vault"], {}, absent.io);
    expect(JSON.parse(absent.out.join("\n")).items).toHaveLength(0);
  });

  it("refuses to seed demo fixtures into the default archive directory", async () => {
    const c = capture();
    expect(await runCli(["seed-demo"], {}, c.io)).toBe(1);
    expect(c.err.join("\n")).toContain("refusing to seed demo fixtures");
  });

  it("errors on an unknown command and on a missing report", async () => {
    expect(await runCli(["bogus", "--dir", dir], {}, capture().io)).toBe(1);
    const c = capture();
    expect(await runCli(["get", "a".repeat(64), "--dir", dir], {}, c.io)).toBe(1);
    expect(c.err.join("\n")).toContain("no observations");
  });
});

describe("end-to-end: audit pass -> persist -> restart -> serve -> freshness changes", () => {
  it("survives an archive restart and reflects clock-driven freshness without rewriting history", async () => {
    const path = join(dir, "archive.json");
    const calls: unknown[][] = [];

    // 1. An audit pass persists a report through the sink into a real on-disk archive.
    const writer = new JsonFileReportArchive(path);
    const view: LifecycleBattleView = {
      locked: false,
      communities: [{ chain_id: "46630", token_address: TOKEN, representation: "aa.token.testnet", custody_domain: "vault-1", reference_chain_id: REF_CHAIN, reference_address: REF_TOKEN }],
    };
    const pass = createLifecycleAuditPass({
      source: { count: async () => 1, get: async () => view },
      archive: writer,
      arena: "arena.testnet",
      refresh: {
        policy: FIXTURE_RESOLVED,
        registry,
        now: () => NOW,
        fetchGoPlus: async () => refGoplus(),
        fetchLp: async () => refLp("10001"),
        submitter: new AuditSubmitter("arena.testnet", { call: async (...a: unknown[]) => void calls.push(a) } as never),
        records: new Map(),
      },
    });
    await pass();
    const evidenceHash = (await writer.snapshot())[0]!.report.evidenceHash;
    expect((await writer.snapshot())[0]!.report.result).toBe("pass");

    // 2. Destroy and recreate the archive object from the same path; serve it read-only.
    let clock = NOW;
    const server = await startReportServer(18094, { archive: new JsonFileReportArchive(path), now: () => clock }, "127.0.0.1");
    try {
      const before = await (await fetch(`http://127.0.0.1:18094/audit-reports/${evidenceHash}`)).json();
      expect(before.observations).toHaveLength(1);
      expect(before.observations[0].historicalResult).toBe("pass");
      expect(before.observations[0].freshness).toBe("fresh");
      expect(before.observations[0].currentApproval).toBe("notEstablished");

      // 3. Advance the clock past the recorded expiry: freshness flips, history stays a pass.
      clock = new Date(NOW.getTime() + 20 * 60_000);
      const after = await (await fetch(`http://127.0.0.1:18094/audit-reports/${evidenceHash}`)).json();
      expect(after.observations[0].historicalResult).toBe("pass"); // unchanged
      expect(after.observations[0].freshness).toBe("expired");
      expect(after.observations[0].currentApproval).toBe("notEstablished");
    } finally {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    }
  });
});
