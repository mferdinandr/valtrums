// FIXTURE-ONLY: in-process HTTP server with fake chain access. No network beyond localhost.
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Challenges, nep413Digest, SIGN_IN_MESSAGE, SIGN_IN_RECIPIENT } from "../../src/hosted/auth.js";
import { issueSession, parseKek } from "../../src/hosted/crypto.js";
import { HostedAgents } from "../../src/hosted/manager.js";
import { createHostedServer } from "../../src/hosted/server.js";
import { AgentStore } from "../../src/hosted/store.js";

const KEK = parseKek("33".repeat(32));
const servers: Array<{ close: () => void }> = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

let n = 0;
async function boot() {
  const agents = new HostedAgents({
    store: new AgentStore(null),
    kek: KEK,
    limits: { maxAgentsPerOwner: 1, maxModelCallsPerAgentHour: 12, maxModelCallsGlobalHour: 100, maxTokenWholePerAgent: 100 },
    killSwitch: () => false,
    now: Date.now,
    newKey: () => ({ account: `acct${++n}`, publicKey: "ed25519:pk", secretKey: "ed25519:SECRETKEY" }),
    funds: async () => ({ nearYocto: 1n, tokenBase: [1n] }),
    runRound: async () => {},
    log: () => {},
  });
  const server = createHostedServer({ agents, challenges: new Challenges(), kek: KEK, keyBelongsTo: async () => true, allowedOrigin: "https://app.test" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const auth = (account: string) => ({ authorization: `Bearer ${issueSession(KEK, account, Date.now(), 60_000)}`, "content-type": "application/json" });
const call = (base: string, path: string, init: RequestInit = {}) => fetch(base + path, init).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown>, headers: r.headers }));

describe("hosted agent server", () => {
  it("rejects calls without a session", async () => {
    const base = await boot();
    expect((await call(base, "/agents")).status).toBe(401);
    expect((await call(base, "/agents", { headers: { authorization: "Bearer junk" } })).status).toBe(401);
  });
  it("signs a wallet in with a challenge and returns a session", async () => {
    const base = await boot();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(12));
    const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let v = BigInt("0x" + raw.toString("hex"));
    let b58 = "";
    while (v > 0n) { b58 = B58[Number(v % 58n)]! + b58; v /= 58n; }
    const ch = (await call(base, "/auth/challenge", { method: "POST", body: JSON.stringify({ accountId: "owner.testnet" }) })).body as { nonce: string };
    const signature = sign(null, nep413Digest(SIGN_IN_MESSAGE, Buffer.from(ch.nonce, "base64"), SIGN_IN_RECIPIENT), privateKey).toString("base64");
    const ok = await call(base, "/auth/verify", { method: "POST", body: JSON.stringify({ accountId: "owner.testnet", publicKey: `ed25519:${b58}`, signature, nonce: ch.nonce }) });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.token).toBe("string");
    const bad = await call(base, "/auth/verify", { method: "POST", body: JSON.stringify({ accountId: "owner.testnet", publicKey: `ed25519:${b58}`, signature, nonce: ch.nonce }) });
    expect(bad.status).toBe(401); // the nonce is spent
  });
  it("creates, lists, starts, stops and exports for the owner only", async () => {
    const base = await boot();
    const created = await call(base, "/agents", { method: "POST", headers: auth("o.testnet"), body: JSON.stringify({ style: "crowd" }) });
    expect(created.status).toBe(200);
    const account = created.body.account as string;
    expect(JSON.stringify(created.body)).not.toContain("SECRETKEY");
    expect((await call(base, `/agents/${account}/start`, { method: "POST", headers: auth("o.testnet") })).body.running).toBe(true);
    expect((await call(base, `/agents/${account}/stop`, { method: "POST", headers: auth("o.testnet") })).body.running).toBe(false);
    expect((await call(base, `/agents/${account}`, { headers: auth("x.testnet") })).status).toBe(404);
    expect((await call(base, `/agents/${account}/export`, { method: "POST", headers: auth("x.testnet") })).status).toBe(404);
    expect((await call(base, `/agents/${account}/export`, { method: "POST", headers: auth("o.testnet") })).body.secretKey).toBe("ed25519:SECRETKEY");
    expect(((await call(base, "/agents", { headers: auth("o.testnet") })).body.agents as unknown[]).length).toBe(1);
  });
  it("enforces the agent limit and sets CORS to the configured origin", async () => {
    const base = await boot();
    await call(base, "/agents", { method: "POST", headers: auth("o.testnet"), body: JSON.stringify({ style: "crowd" }) });
    const second = await call(base, "/agents", { method: "POST", headers: auth("o.testnet"), body: JSON.stringify({ style: "crowd" }) });
    expect(second.status).toBe(403);
    expect(second.headers.get("access-control-allow-origin")).toBe("https://app.test");
  });
  it("rejects oversized and malformed bodies", async () => {
    const base = await boot();
    const big = await call(base, "/auth/challenge", { method: "POST", body: "x".repeat(10_000) });
    expect(big.status).toBe(413);
    expect((await call(base, "/auth/challenge", { method: "POST", body: "[1]" })).status).toBe(400);
  });
});
