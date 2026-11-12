// FIXTURE-ONLY: temporary files and an in-process Postgres (PGlite) running the real migrations.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importAppState, readAppStateFiles } from "../../src/app-state/import.js";
import { PgReportArchive } from "../../src/app-state/pg-report-archive.js";
import { PgActionStore, PgBaselineStore, loadPgPlayerState } from "../../src/app-state/pg-stores.js";
import { evaluateCommunity } from "../../src/audit/decision.js";
import { JsonFileReportArchive, type ArchiveObservationInput } from "../../src/audit/report-archive.js";
import { buildAuditReport } from "../../src/audit/report.js";
import { ACTION_STORE_VERSION, type ActionRecord } from "../../src/mcp/actions/store.js";
import { pgliteWithMigrations } from "../hosted/pglite.js";
import { FIXTURE_RESOLVED, NOW, asset, goplus, lp } from "../audit/fixtures.js";

const report = (over: Record<string, string | undefined> = {}) => buildAuditReport(evaluateCommunity({ asset, goplus: goplus(over), lp: lp("10001"), policy: FIXTURE_RESOLVED, now: NOW }));
const input = (over: Record<string, string | undefined> = {}, battleId = 1): ArchiveObservationInput => ({ report: report(over), attribution: { arena: "a.testnet", battleId, community: 0 }, provenance: "fixture" });
const action = (id: string) => ({ actionId: id, caller: "u.testnet", status: "previewed", history: [] }) as unknown as ActionRecord;
const state = { version: 1 as const, acted: { k: { at: 1, actionId: "x", txHash: "h", status: "sent" } }, blocked: {}, failures: 0 };

async function fixtureFiles() {
  const dir = mkdtempSync(join(tmpdir(), "app-import-"));
  const actions = join(dir, "actions.json");
  writeFileSync(actions, JSON.stringify({ version: ACTION_STORE_VERSION, actions: { a1: action("a1"), a2: action("a2") } }));
  const archive = join(dir, "archive.json");
  const fileArchive = new JsonFileReportArchive(archive);
  await fileArchive.put(input());
  await fileArchive.put(input({ sell_tax: "0.01" }, 2));
  const baselines = join(dir, "baselines.json");
  writeFileSync(baselines, JSON.stringify({ "7": { WALLET: 1000, CASHCAT: 2000 } }));
  const playerState = join(dir, "player-state.json");
  writeFileSync(playerState, JSON.stringify(state));
  const env = { ACTION_STORE_PATH: actions, PLAYER_ACTION_STORE_PATH: join(dir, "none.json"), AUDIT_ARCHIVE_PATH: archive, BASELINE_STORE_PATH: baselines, PLAYER_STATE_PATH: playerState, PLAYER_AUTONOMOUS_STATE_PATH: join(dir, "none2.json") };
  return { dir, env, fileArchive };
}

describe("application state import", () => {
  it("loads every store without changing a value and keeps the audit seq and timestamps", async () => {
    const { env, fileArchive } = await fixtureFiles();
    const { db } = await pgliteWithMigrations();
    const files = await readAppStateFiles(env);
    expect(await importAppState(db, files)).toEqual({ actions: 2, observations: 2, baselines: 1, playerStates: 1 });
    expect((await new PgActionStore(db).get("a2"))?.caller).toBe("u.testnet");
    expect(await new PgBaselineStore(db).get(7)).toEqual({ WALLET: 1000, CASHCAT: 2000 });
    expect((await loadPgPlayerState(db, "player:grants")).state.has("k")).toBe(true);
    expect(await new PgReportArchive(db).snapshot()).toEqual(await fileArchive.snapshot()); // identical, including seq and archivedAt
  });

  it("is safe to run twice and new observations continue after the imported ones", async () => {
    const { env } = await fixtureFiles();
    const { db } = await pgliteWithMigrations();
    const files = await readAppStateFiles(env);
    await importAppState(db, files);
    expect(await importAppState(db, files)).toEqual({ actions: 0, observations: 0, baselines: 0, playerStates: 0 });
    const next = await new PgReportArchive(db).put(input({ sell_tax: "0.02" }, 3));
    expect(next.created).toBe(true);
    expect(next.observation.seq).toBeGreaterThan(2);
    expect(await new PgReportArchive(db).snapshot()).toHaveLength(3);
  });

  it("imports into an empty archive so the first new observation still gets seq 1 or more", async () => {
    const { db } = await pgliteWithMigrations();
    await importAppState(db, { actions: new Map(), observations: [], baselines: new Map(), playerStates: new Map() });
    expect((await new PgReportArchive(db).put(input())).observation.seq).toBeGreaterThanOrEqual(1);
  });

  it("stops on a malformed file instead of skipping it", async () => {
    const { dir, env } = await fixtureFiles();
    writeFileSync(env.BASELINE_STORE_PATH, JSON.stringify({ "7": { WALLET: "lots" } }));
    await expect(readAppStateFiles(env)).rejects.toThrow(/malformed baseline/);
    writeFileSync(env.ACTION_STORE_PATH, "not json");
    writeFileSync(env.BASELINE_STORE_PATH, "{}");
    await expect(readAppStateFiles(env)).rejects.toThrow(/not readable JSON/);
    expect(dir).toBeTruthy();
  });

  it("does not import files that do not exist", async () => {
    const files = await readAppStateFiles({ ACTION_STORE_PATH: "/nonexistent/a.json", PLAYER_ACTION_STORE_PATH: "/nonexistent/b.json", AUDIT_ARCHIVE_PATH: "/nonexistent/c.json", BASELINE_STORE_PATH: "/nonexistent/d.json", PLAYER_STATE_PATH: "/nonexistent/e.json", PLAYER_AUTONOMOUS_STATE_PATH: "/nonexistent/f.json" });
    expect([files.actions.size, files.observations.length, files.baselines.size, files.playerStates.size]).toEqual([0, 0, 0, 0]);
  });
});
