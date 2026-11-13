// FIXTURE-ONLY: configuration parsing and an in-process Postgres (PGlite) running the real migrations. No network.
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { PgOracleStatusStore, loadPgOracleStatus } from "../../src/app-state/pg-oracle-status.js";
import type { LockSession } from "../../src/app-state/pg-session.js";
import type { Db } from "../../src/hosted/db.js";
import { loadOracleConfig } from "../../src/lifecycle-oracle/config.js";
import { OracleLockedError, STATUS_SCHEMA, type OracleStatus } from "../../src/lifecycle-oracle/status.js";
import { loadObservationConfig } from "../../src/observations/config.js";
import { journalStoreFromEnv } from "../../src/observations/journal-store.js";
import { pgliteWithMigrations } from "../hosted/pglite.js";
import { NS } from "../observations/fixtures.js";

const URL = "postgres://agent@localhost:5432/app";

describe("OBSERVATION_JOURNAL_STORE", () => {
  it("defaults to the file journal, even with APP_DATABASE_URL set", () => {
    expect(journalStoreFromEnv({ OBSERVATION_JOURNAL_DIR: "/j", APP_DATABASE_URL: URL })).toEqual({ kind: "file", dir: "/j" });
    expect(journalStoreFromEnv({ APP_DATABASE_URL: URL })).toBeNull();
  });

  it("selects the database only explicitly, and needs its URL", () => {
    expect(journalStoreFromEnv({ OBSERVATION_JOURNAL_STORE: "database", APP_DATABASE_URL: URL })).toEqual({ kind: "database", url: URL });
    expect(() => journalStoreFromEnv({ OBSERVATION_JOURNAL_STORE: "database" })).toThrow(/requires APP_DATABASE_URL/);
    expect(() => journalStoreFromEnv({ OBSERVATION_JOURNAL_STORE: "s3" })).toThrow(/"file" or "database"/);
  });

  it("refuses a mixed file and database configuration", () => {
    expect(() => journalStoreFromEnv({ OBSERVATION_JOURNAL_STORE: "database", APP_DATABASE_URL: URL, OBSERVATION_JOURNAL_DIR: "/j" })).toThrow(/only one/);
  });

  it("the read API observation config follows the switch", () => {
    expect(loadObservationConfig({ OBSERVATION_JOURNAL_STORE: "database", APP_DATABASE_URL: URL, OBSERVATION_QUALIFIED_MODES: "PriceGain" }))
      .toMatchObject({ dir: null, databaseUrl: URL });
  });

  it("the oracle keeps its status with the journal and refuses a status directory in database mode", () => {
    const base = { ORACLE_ACCOUNT_ID: "oracle.testnet", ORACLE_PRIVATE_KEY: "ed25519:fixture", ARENA_CONTRACT_ID: "arena.testnet",
      ARENA_APPLICATION_OBSERVATION_SCOPE: JSON.stringify({ ...NS, arenaContract: "arena.testnet" }) };
    const db = loadOracleConfig({ ...base, OBSERVATION_JOURNAL_STORE: "database", APP_DATABASE_URL: URL });
    expect(db).toMatchObject({ stateDir: null, journalDir: null, databaseUrl: URL });
    expect(() => loadOracleConfig({ ...base, OBSERVATION_JOURNAL_STORE: "database", APP_DATABASE_URL: URL, ORACLE_STATE_DIR: "/s" })).toThrow(/only one/);
    expect(loadOracleConfig({ ...base, ORACLE_STATE_DIR: "/s", OBSERVATION_JOURNAL_DIR: "/j" })).toMatchObject({ stateDir: "/s", journalDir: "/j" });
  });
});

describe("lifecycle oracle status in Postgres", () => {
  let db: Db;
  let raw: PGlite;
  beforeAll(async () => {
    ({ db, raw } = await pgliteWithMigrations());
  });
  const session = (locked = false): LockSession & { closed: boolean } => {
    const s = {
      closed: false,
      query: (async (sql: string, params?: unknown[]) => (locked && sql.includes("pg_try_advisory_lock") ? { rows: [{ ok: false }] } : db.query(sql, params))) as Db["query"],
      close: async () => void (s.closed = true),
    };
    return s;
  };
  const status = (updatedAtMs: string): OracleStatus => ({
    schema: STATUS_SCHEMA, updatedAtMs, writesEnabled: true, accountId: "oracle.testnet", contract: "arena.testnet", passes: 1, passError: null, battles: {},
  });

  it("stores the latest status per namespace and reads it back", async () => {
    const store = await PgOracleStatusStore.open({ db, session: session(), namespace: NS });
    await store.write(status("1"));
    await store.write(status("2"));
    expect((await loadPgOracleStatus(db, NS)).updatedAtMs).toBe("2");
    expect((await raw.query("select count(*)::int as n from public.lifecycle_oracle_status")).rows[0]).toEqual({ n: 1 });
    await expect(loadPgOracleStatus(db, { ...NS, deploymentId: "other" })).rejects.toThrow(/not found/);
  });

  it("refuses a second oracle for the namespace and releases its session", async () => {
    const s = session(true);
    await expect(PgOracleStatusStore.open({ db, session: s, namespace: NS })).rejects.toBeInstanceOf(OracleLockedError);
    expect(s.closed).toBe(true);
  });

  it("refuses a malformed status instead of reporting it healthy", async () => {
    const ns = { ...NS, deploymentId: "malformed" };
    const store = await PgOracleStatusStore.open({ db, session: session(), namespace: ns });
    await store.write({ ...status("3"), schema: "other" } as unknown as OracleStatus);
    await expect(loadPgOracleStatus(db, ns)).rejects.toThrow(/malformed/);
  });
});
