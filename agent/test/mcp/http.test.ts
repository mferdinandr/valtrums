import { describe, expect, it } from "vitest";
import { handleReadRequest } from "../../src/mcp/http.js";
import { makeDeps, signRead } from "./fixtures.js";

describe("read API over HTTP", () => {
  it("runs read tools with GET and lists them", async () => {
    const deps = await makeDeps();
    const list = await handleReadRequest({ method: "GET", url: "/tools" }, deps);
    expect(JSON.parse(list.body).tools).toHaveLength(10);
    const res = await handleReadRequest({ method: "GET", url: "/tools/list_battles?mode=LowestDrawdown&limit=5" }, deps);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ network: "near-testnet", source: { kind: "fixture" }, freshness: "fresh" });
  });

  it("serves the signing parameters (message and recipients) read-only and without secrets", async () => {
    const deps = await makeDeps();
    const res = await handleReadRequest({ method: "GET", url: "/session/config" }, deps);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ schemaVersion: "arena-session-config-v1", readMessage: expect.stringContaining("read-only session"), sessionRecipient: "valtrum-read.test", actionRecipient: null });
    expect(JSON.stringify(body)).not.toMatch(/secret|token/i);
    expect((await handleReadRequest({ method: "POST", url: "/session/config", body: "{}" }, deps)).status).toBe(405);
  });

  it("takes the session only from the Authorization header and refuses other accounts", async () => {
    const deps = await makeDeps();
    const inUrl = await handleReadRequest({ method: "GET", url: `/tools/inspect_positions?session=${deps.aliceToken}` }, deps);
    expect(inUrl.status).toBe(400);
    const none = await handleReadRequest({ method: "GET", url: "/tools/inspect_positions" }, deps);
    expect(none.status).toBe(403);
    const other = await handleReadRequest(
      { method: "GET", url: "/tools/inspect_positions?accountId=bob.testnet", authorization: `Bearer ${deps.aliceToken}` }, deps);
    expect(other.status).toBe(403);
    const own = await handleReadRequest(
      { method: "GET", url: "/tools/inspect_positions?battleIds=1,2", authorization: `Bearer ${deps.aliceToken}` }, deps);
    expect(own.status).toBe(200);
    expect(JSON.parse(own.body).data.accountId).toBe("alice.testnet");
  });

  it("opens sessions with POST and has no write route", async () => {
    const deps = await makeDeps();
    const ok = await handleReadRequest({ method: "POST", url: "/session", body: JSON.stringify(signRead("dave.testnet")) }, deps);
    expect(ok.status).toBe(200);
    const bad = await handleReadRequest({ method: "POST", url: "/session", body: JSON.stringify({ ...signRead("dave.testnet"), accountId: "eve.testnet" }) }, deps);
    expect(bad.status).toBe(401);
    expect((await handleReadRequest({ method: "POST", url: "/tools/list_battles" }, deps)).status).toBe(405);
    expect((await handleReadRequest({ method: "GET", url: "/tools/submit_action" }, deps)).status).toBe(400);
    expect((await handleReadRequest({ method: "GET", url: "/actions" }, deps)).status).toBe(404);
    expect((await handleReadRequest({ method: "GET", url: "/tools/list_battles?mode=Nope" }, deps)).status).toBe(400);
  });
});
