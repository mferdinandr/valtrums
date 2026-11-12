// FIXTURE-ONLY: in-process HTTP server with fake chain access. No network beyond localhost.
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Challenges, nep413Digest, SIGN_IN_MESSAGE, SIGN_IN_RECIPIENT } from "../../src/hosted/auth.js";
import { parseKek } from "../../src/hosted/crypto.js";
import { HostedAgents } from "../../src/hosted/manager.js";
import { PgHostedRepository } from "../../src/hosted/pg-store.js";
import { FileHostedRepository, type HostedRepository } from "../../src/hosted/repository.js";
import { createHostedServer, SESSION_COOKIE, type ServerOptions } from "../../src/hosted/server.js";
import { DbSessions, HmacSessions, type SessionStore } from "../../src/hosted/sessions.js";
import { AgentStore } from "../../src/hosted/store.js";
import { pgliteWithMigrations } from "./pglite.js";

const KEK = parseKek("33".repeat(32));
const servers: Array<{ close: () => void }> = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const wallet = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(12));
  let v = BigInt("0x" + raw.toString("hex"));
  let b58 = "";
  while (v > 0n) { b58 = B58[Number(v % 58n)]! + b58; v /= 58n; }
  return { publicKey: `ed25519:${b58}`, sign: (nonce: string) => sign(null, nep413Digest(SIGN_IN_MESSAGE, Buffer.from(nonce, "base64"), SIGN_IN_RECIPIENT), privateKey).toString("base64") };
};

let n = 0;
async function boot(over: { repo?: HostedRepository; sessions?: SessionStore; origin?: string; cookie?: ServerOptions["cookie"] } = {}) {
  const repo = over.repo ?? new FileHostedRepository(new AgentStore(null), null);
  const agents = new HostedAgents({
    repo,
    kek: KEK,
    limits: { maxAgentsPerOwner: 1, maxModelCallsPerAgentHour: 12, maxModelCallsGlobalHour: 100, maxTokenWholePerAgent: 100 },
    killSwitch: () => false,
    now: Date.now,
    newKey: () => ({ account: `acct${++n}`, publicKey: "ed25519:pk", secretKey: "ed25519:SECRETKEY" }),
    funds: async () => ({ nearYocto: 1n, tokenBase: [1n] }),
    runRound: async () => {},
    log: () => {},
  });
  const server = createHostedServer({
    agents,
    challenges: new Challenges(),
    sessions: over.sessions ?? new HmacSessions(KEK),
    keyBelongsTo: async () => true,
    allowedOrigin: over.origin ?? "https://app.test",
    ...(over.cookie ? { cookie: over.cookie } : {}),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const call = (base: string, path: string, init: RequestInit = {}) =>
  fetch(base + path, init).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown>, headers: r.headers }));
const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(base, path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** Signs in with a fresh wallet and returns the session cookie the service set. */
async function signIn(base: string, account = "o.testnet") {
  const w = wallet();
  const ch = (await post(base, "/auth/challenge", { accountId: account })).body as { nonce: string };
  const res = await post(base, "/auth/verify", { accountId: account, publicKey: w.publicKey, signature: w.sign(ch.nonce), nonce: ch.nonce });
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { res, setCookie, cookie: setCookie.split(";")[0] ?? "" };
}
const withCookie = (cookie: string) => ({ cookie, "content-type": "application/json" });

describe("hosted agent server", () => {
  it("rejects calls without a session", async () => {
    const base = await boot();
    expect((await call(base, "/agents")).status).toBe(401);
    expect((await call(base, "/agents", { headers: { authorization: "Bearer junk" } })).status).toBe(401);
    expect((await call(base, "/auth/session")).status).toBe(401);
  });

  it("signs in with a challenge, sets an httpOnly cookie and puts no token in the body", async () => {
    const base = await boot();
    const { res, setCookie } = await signIn(base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ owner: "o.testnet", expiresInMs: 3_600_000 });
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure"); // the allowed origin is https
  });

  it("does not accept a spent nonce", async () => {
    const base = await boot();
    const w = wallet();
    const ch = (await post(base, "/auth/challenge", { accountId: "o.testnet" })).body as { nonce: string };
    const proof = { accountId: "o.testnet", publicKey: w.publicKey, signature: w.sign(ch.nonce), nonce: ch.nonce };
    expect((await post(base, "/auth/verify", proof)).status).toBe(200);
    expect((await post(base, "/auth/verify", proof)).status).toBe(401);
  });

  it("restores the session from the cookie and ends it on logout", async () => {
    const base = await boot();
    const { cookie } = await signIn(base);
    expect((await call(base, "/auth/session", { headers: { cookie } })).body).toEqual({ owner: "o.testnet" });
    const out = await post(base, "/auth/logout", {}, { cookie });
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("keeps the session on the database store and ends it on logout", async () => {
    const { db } = await pgliteWithMigrations();
    const base = await boot({ repo: new PgHostedRepository(db), sessions: new DbSessions(db) });
    const { cookie } = await signIn(base);
    expect((await call(base, "/auth/session", { headers: { cookie } })).status).toBe(200);
    await post(base, "/auth/logout", {}, { cookie });
    expect((await call(base, "/auth/session", { headers: { cookie } })).status).toBe(401); // revoked server-side
  });

  it("creates, lists, starts, stops and exports for the owner only", async () => {
    const base = await boot();
    const { cookie } = await signIn(base);
    const other = await signIn(base, "x.testnet");
    const created = await post(base, "/agents", { style: "crowd" }, { cookie });
    expect(created.status).toBe(200);
    const account = created.body.account as string;
    expect(JSON.stringify(created.body)).not.toContain("SECRETKEY");
    expect((await post(base, `/agents/${account}/start`, {}, { cookie })).body.running).toBe(true);
    expect((await post(base, `/agents/${account}/stop`, {}, { cookie })).body.running).toBe(false);
    expect((await call(base, `/agents/${account}`, { headers: withCookie(other.cookie) })).status).toBe(404);
    expect((await post(base, `/agents/${account}/export`, {}, { cookie: other.cookie })).status).toBe(404);
    expect((await post(base, `/agents/${account}/export`, {}, { cookie })).body.secretKey).toBe("ed25519:SECRETKEY");
    expect(((await call(base, "/agents", { headers: withCookie(cookie) })).body.agents as unknown[]).length).toBe(1);
  });

  it("still accepts a bearer token for non-browser clients", async () => {
    const base = await boot();
    const { cookie } = await signIn(base);
    const token = cookie.slice(SESSION_COOKIE.length + 1);
    expect((await call(base, "/agents", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it("enforces the agent limit and sets CORS with credentials for the configured origin", async () => {
    const base = await boot();
    const { cookie } = await signIn(base);
    await post(base, "/agents", { style: "crowd" }, { cookie });
    const second = await post(base, "/agents", { style: "crowd" }, { cookie });
    expect(second.status).toBe(403);
    expect(second.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(second.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("uses a non-secure cookie on plain http (local development)", async () => {
    const base = await boot({ origin: "http://localhost:3000" });
    expect((await signIn(base)).setCookie).not.toContain("Secure");
  });

  it("refuses SameSite=None without a secure cookie", () => {
    expect(() =>
      createHostedServer({ agents: {} as HostedAgents, challenges: new Challenges(), sessions: new HmacSessions(KEK), keyBelongsTo: async () => true, allowedOrigin: "http://localhost:3000", cookie: { sameSite: "None" } }),
    ).toThrow(/Secure/);
  });

  it("rejects oversized and malformed bodies", async () => {
    const base = await boot();
    expect((await call(base, "/auth/challenge", { method: "POST", body: "x".repeat(10_000) })).status).toBe(413);
    expect((await call(base, "/auth/challenge", { method: "POST", body: "[1]" })).status).toBe(400);
  });
});
