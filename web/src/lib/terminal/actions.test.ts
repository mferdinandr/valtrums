// FIXTURE-ONLY: the action API and wallet are scripted; nothing reaches a network.
import { describe, expect, it } from "vitest";
import { proxyAction } from "../arena-read/proxy";
import { actionAuthorizationMessage, fixtureNotice, runTerminalAction, type ActionWallet, type UnsignedTransaction } from "./actions";

const ok = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { data } : data), { status });
const TX: UnsignedTransaction = {
  signerId: "alice.testnet",
  receiverId: "pepe.rep.testnet",
  actions: [{ type: "FunctionCall", methodName: "ft_transfer_call", args: { receiver_id: "arena.testnet", amount: "100", msg: "m" }, gas: "1", deposit: "1" }],
};
const record = (status: string, extra: Record<string, unknown> = {}) => ({
  actionId: "act_" + "a".repeat(32),
  previewHash: "f".repeat(64),
  status,
  reason: null,
  preview: { expiresAtMs: 0, accountId: "alice.testnet", transaction: TX, costs: {}, binding: {} },
  ...extra,
});

function scripted(responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetchImpl: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error("unexpected call");
      return next;
    },
  };
}

function wallet() {
  const sent: UnsignedTransaction[] = [];
  const messages: string[] = [];
  const w: ActionWallet = {
    signMessage: async (message) => {
      messages.push(message);
      return { accountId: "alice.testnet", publicKey: "ed25519:pk", signature: "sig", nonce: "bm9uY2U=" };
    },
    signAndSend: async (tx) => {
      sent.push(tx);
      return "8".repeat(44);
    },
  };
  return { w, sent, messages };
}

describe("terminal action path", () => {
  it("signs the preview hash, sends exactly the prepared transaction and waits for a verified receipt", async () => {
    const api = scripted([
      ok(record("previewed")),
      ok(record("authorized")),
      ok({ record: record("ready_to_sign"), transaction: TX }),
      ok(record("broadcast")),
      ok(record("broadcast")),
      ok(record("confirmed")),
    ]);
    const { w, sent, messages } = wallet();
    const result = await runTerminalAction({ kind: "deposit", battleId: 1, community: 0, amount: "100" }, {
      session: "s.t",
      wallet: w,
      fetchImpl: api.fetchImpl,
      sleep: async () => {},
    });
    expect(result).toEqual({ ok: true, status: "confirmed", actionId: "act_" + "a".repeat(32), txHash: "8".repeat(44) });
    expect(messages).toEqual([actionAuthorizationMessage("f".repeat(64))]);
    expect(sent).toEqual([TX]);
    expect(api.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "POST /api/arena/actions",
      `POST /api/arena/actions/act_${"a".repeat(32)}/authorize`,
      `POST /api/arena/actions/act_${"a".repeat(32)}/prepare`,
      `POST /api/arena/actions/act_${"a".repeat(32)}/broadcast`,
      `GET /api/arena/actions/act_${"a".repeat(32)}`,
      `GET /api/arena/actions/act_${"a".repeat(32)}`,
    ]);
    for (const c of api.calls) expect(c.url).not.toContain("s.t");
  });

  it("stays pending when no verified receipt arrives, and never reports a broadcast as done", async () => {
    const api = scripted([ok(record("previewed")), ok(record("authorized")), ok({ record: record("ready_to_sign"), transaction: TX }), ok(record("broadcast")), ok(record("broadcast"))]);
    const result = await runTerminalAction({ kind: "deposit" }, { session: "s", wallet: wallet().w, fetchImpl: api.fetchImpl, sleep: async () => {}, maxPolls: 1 });
    expect(result).toMatchObject({ ok: false, status: "broadcast", reason: "broadcast; waiting for a verified receipt" });
  });

  it("an unsupported route or a rejected revalidation sends nothing", async () => {
    const unsupported = scripted([ok({ error: "unsupported_route: funding route \"intents\" is not supported" }, 400)]);
    const w1 = wallet();
    const r1 = await runTerminalAction({ kind: "deposit", route: "intents" }, { session: "s", wallet: w1.w, fetchImpl: unsupported.fetchImpl });
    expect(r1).toMatchObject({ ok: false, status: "error" });
    expect(w1.sent).toEqual([]);
    expect(w1.messages).toEqual([]);
    const changed = scripted([ok(record("previewed")), ok(record("authorized")), ok({ error: "invalid_request: the action changed since it was authorized" }, 400)]);
    const w2 = wallet();
    const r2 = await runTerminalAction({ kind: "deposit" }, { session: "s", wallet: w2.w, fetchImpl: changed.fetchImpl });
    expect(r2).toMatchObject({ ok: false, reason: expect.stringMatching(/changed/) });
    expect(w2.sent).toEqual([]);
  });
});

describe("action proxy", () => {
  const env = { ARENA_READ_API_URL: "http://127.0.0.1:8790/" };
  it("forwards only the action paths, with the session in the header", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const doFetch = async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response("{}", { status: 200 });
    };
    const id = "act_" + "b".repeat(32);
    await proxyAction({ method: "POST" }, "{}", "Bearer a.b", env, doFetch);
    await proxyAction({ method: "GET", id }, "", "Bearer a.b", env, doFetch);
    await proxyAction({ method: "POST", id, step: "prepare" }, "{}", "Bearer a.b", env, doFetch);
    expect(seen.map((s) => `${s.init.method} ${s.url}`)).toEqual([
      "POST http://127.0.0.1:8790/actions",
      `GET http://127.0.0.1:8790/actions/${id}`,
      `POST http://127.0.0.1:8790/actions/${id}/prepare`,
    ]);
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer a.b");
    expect((await proxyAction({ method: "POST", id, step: "sign" }, "{}", null, env, doFetch)).status).toBe(404);
    expect((await proxyAction({ method: "GET", id: "../../tools" }, "", null, env, doFetch)).status).toBe(404);
    expect((await proxyAction({ method: "GET" }, "", null, env, doFetch)).status).toBe(405);
    expect((await proxyAction({ method: "POST" }, "x".repeat(9000), null, env, doFetch)).status).toBe(413);
    expect(seen).toHaveLength(3);
  });
});

describe("intents-fixture label in the terminal path", () => {
  const FIXTURE = { route: "intents-fixture", fixture: true, fixtureLabel: "FIXTURE: local 1Click API fixture on testnet. Not NEAR Intents; no real solver, no mainnet funds." };
  const fixtureRecord = (status: string) => {
    const r = record(status);
    return { ...r, preview: { ...r.preview, binding: FIXTURE } };
  };

  it("labels results of an action bound to the fixture route, on success and on a stalled receipt", async () => {
    const steps = () => [ok(fixtureRecord("previewed")), ok(fixtureRecord("authorized")), ok({ record: fixtureRecord("ready_to_sign"), transaction: TX }), ok(fixtureRecord("broadcast"))];
    const done = await runTerminalAction({ kind: "deposit", route: "intents-fixture" }, { session: "s", wallet: wallet().w, fetchImpl: scripted([...steps(), ok(fixtureRecord("confirmed"))]).fetchImpl, sleep: async () => {} });
    expect(done).toMatchObject({ ok: true, fixture: FIXTURE.fixtureLabel });
    const stalled = await runTerminalAction({ kind: "deposit", route: "intents-fixture" }, { session: "s", wallet: wallet().w, fetchImpl: scripted([...steps(), ok(fixtureRecord("broadcast"))]).fetchImpl, sleep: async () => {}, maxPolls: 1 });
    expect(stalled).toMatchObject({ ok: false, status: "broadcast", fixture: FIXTURE.fixtureLabel });
  });

  it("does not label a direct action", async () => {
    const api = scripted([ok(record("previewed")), ok(record("authorized")), ok({ record: record("ready_to_sign"), transaction: TX }), ok(record("broadcast")), ok(record("confirmed"))]);
    const result = await runTerminalAction({ kind: "deposit" }, { session: "s", wallet: wallet().w, fetchImpl: api.fetchImpl, sleep: async () => {} });
    expect(result).not.toHaveProperty("fixture");
    expect(fixtureNotice({ route: "direct" })).toBeNull();
    expect(fixtureNotice(undefined)).toBeNull();
  });
});
