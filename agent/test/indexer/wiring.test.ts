// FIXTURE-ONLY: a recorded chain file in a temp directory; no live RPC, no write transport.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadReportArchiveConfig, DEFAULT_REPORT_ARCHIVE_PATH } from "../../src/audit/config.js";
import { createIndexerRuntime, loadIndexerRuntimeConfig } from "../../src/indexer/wiring.js";
import { JsonFileIndexerStore } from "../../src/indexer/store.js";
import { chainFile, created, deposit, linked, outcome } from "./fixtures.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "indexer-wiring-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("indexer runtime config (off by default)", () => {
  it("is off unless INDEXER_ENABLED=true", () => {
    expect(loadIndexerRuntimeConfig({}, "arena.testnet")).toBeNull();
    expect(loadIndexerRuntimeConfig({ INDEXER_ENABLED: "false", INDEXER_RECORDED_CHAIN: "x.json" }, "arena.testnet")).toBeNull();
  });

  it("fails closed without a recorded chain, because no live source exists", () => {
    expect(() => loadIndexerRuntimeConfig({ INDEXER_ENABLED: "true" }, "arena.testnet")).toThrow(/INDEXER_RECORDED_CHAIN/);
  });

  it("reads contracts, state dir, anchor and retention, and rejects bad values", () => {
    const cfg = loadIndexerRuntimeConfig(
      {
        INDEXER_ENABLED: "true",
        INDEXER_RECORDED_CHAIN: "chain.json",
        INDEXER_CONTRACTS: "backing.testnet, payout.testnet, arena.testnet",
        INDEXER_RETENTION_DEPTH: "250",
        INDEXER_STATE_DIR: "/tmp/ix",
        INDEXER_ANCHOR_HEIGHT: "5",
      },
      "arena.testnet",
    );
    expect(cfg).toMatchObject({ contracts: ["arena.testnet", "backing.testnet", "payout.testnet"], retentionDepth: 250, stateDir: "/tmp/ix", anchorHeight: "5" });
    const base = { INDEXER_ENABLED: "true", INDEXER_RECORDED_CHAIN: "chain.json" };
    expect(() => loadIndexerRuntimeConfig({ ...base, INDEXER_RETENTION_DEPTH: "0" }, "a.testnet")).toThrow(/INDEXER_RETENTION_DEPTH/);
    expect(() => loadIndexerRuntimeConfig({ ...base, INDEXER_ANCHOR_HEIGHT: "-1" }, "a.testnet")).toThrow(/INDEXER_ANCHOR_HEIGHT/);
    expect(loadIndexerRuntimeConfig(base, "a.testnet")?.retentionDepth).toBe(10_000);
  });
});

describe("indexer runtime over a recorded chain", () => {
  it("syncs, persists, picks up an updated recording and never throws", async () => {
    const chainPath = join(dir, "chain.json");
    const first = chainFile(
      linked([
        { height: "1", outcomes: [outcome("r1", [created(1)])] },
        { height: "2", outcomes: [outcome("r2", [deposit(1, 0, "bob.testnet", "10")])] },
      ]),
      { finalizedHeight: "2" },
    );
    await writeFile(chainPath, JSON.stringify(first));
    const stateDir = join(dir, "state");
    const rt = await createIndexerRuntime({ recordedChainPath: chainPath, stateDir, contracts: ["arena.testnet"], retentionDepth: 5 });
    expect((await rt.sync())?.status).toBe("healthy");

    const longer = chainFile(
      linked([
        { height: "1", outcomes: [outcome("r1", [created(1)])] },
        { height: "2", outcomes: [outcome("r2", [deposit(1, 0, "bob.testnet", "10")])] },
        { height: "3", outcomes: [outcome("r3", [deposit(1, 0, "bob.testnet", "5")])] },
      ]),
      { finalizedHeight: "3" },
    );
    await writeFile(chainPath, JSON.stringify(longer));
    expect((await rt.sync())?.processedHead?.height).toBe("3");

    await writeFile(chainPath, "not json");
    expect(await rt.sync()).toBeNull(); // a bad recording is logged and isolated, not thrown
    await rt.close();
    expect((await new JsonFileIndexerStore(stateDir).read())?.cursors.finalizedHead?.height).toBe("3");
  });
});

describe("audit report archive sink config (off by default)", () => {
  it("is off unless AUDIT_REPORT_ARCHIVE_ENABLED=true and needs the audit pass", () => {
    expect(loadReportArchiveConfig({}, true)).toBeNull();
    expect(loadReportArchiveConfig({ AUDIT_REPORT_ARCHIVE_ENABLED: "false" }, true)).toBeNull();
    expect(() => loadReportArchiveConfig({ AUDIT_REPORT_ARCHIVE_ENABLED: "true" }, false)).toThrow(/AUDIT_ENABLED/);
    expect(loadReportArchiveConfig({ AUDIT_REPORT_ARCHIVE_ENABLED: "true" }, true)).toEqual({ path: DEFAULT_REPORT_ARCHIVE_PATH });
    expect(loadReportArchiveConfig({ AUDIT_REPORT_ARCHIVE_ENABLED: "true", AUDIT_REPORT_ARCHIVE_PATH: " /data/a.json " }, true)).toEqual({ path: "/data/a.json" });
  });
});

describe("agent runtime wiring", () => {
  it("main.ts injects both opt-in sinks behind their config loaders", async () => {
    const main = await readFile(new URL("../../src/main.ts", import.meta.url), "utf8");
    expect(main).toContain("loadIndexerRuntimeConfig(process.env");
    expect(main).toContain("createIndexerRuntime(");
    expect(main).toContain("loadReportArchiveConfig(process.env");
    expect(main).toMatch(/archive: new JsonFileReportArchive\(/);
  });
});
