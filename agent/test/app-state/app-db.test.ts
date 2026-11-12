import { describe, expect, it } from "vitest";
import { appDb, createReportArchive } from "../../src/app-state/app-db.js";
import { PgReportArchive } from "../../src/app-state/pg-report-archive.js";
import { JsonFileReportArchive } from "../../src/audit/report-archive.js";

describe("application database selection", () => {
  it("is off without APP_DATABASE_URL, so every store keeps its file", () => {
    expect(appDb({})).toBeNull();
    expect(appDb({ APP_DATABASE_URL: "  " })).toBeNull();
    expect(createReportArchive("./x/archive.json", {})).toBeInstanceOf(JsonFileReportArchive);
  });

  it("uses Postgres for the audit archive when the URL is set", async () => {
    // A pool is created lazily; no connection is opened until a query runs.
    const archive = createReportArchive("./x/archive.json", { APP_DATABASE_URL: "postgres://u:p@127.0.0.1:1/db?sslmode=disable" });
    expect(archive).toBeInstanceOf(PgReportArchive);
    const { closeAppDb } = await import("../../src/app-state/app-db.js");
    await closeAppDb();
  });
});
