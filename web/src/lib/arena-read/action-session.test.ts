// FIXTURE-ONLY: fake wallet and fake gateway. No real signature, session or transaction.
import { describe, expect, it, vi } from "vitest";
import { ActionSession, createActionWallet, fetchSessionConfig, makeNonce, toBase64, txHashOf, type WalletLike } from "./action-session";

const config = { schemaVersion: "arena-session-config-v1", readMessage: "Open a read-only session.", sessionRecipient: "valtrum-read", actionRecipient: "valtrum-actions" };
const ACCOUNT = "alice.testnet";

function harness(over: { wallet?: Partial<WalletLike>; session?: Record<string, unknown>; configBody?: unknown; now?: () => number } = {}) {
  const calls: string[] = [];
  const signed: Array<{ message: string; recipient: string; nonce: Uint8Array }> = [];
  const wallet: WalletLike = {
    signMessage: async (p) => { signed.push(p); return { accountId: ACCOUNT, publicKey: "ed25519:k", signature: "c2ln" }; },
    signAndSendTransaction: async () => ({ transaction: { hash: "TXHASH" } }),
    ...over.wallet,
  };
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url}`);
    if (url === "/api/arena/session/config") return Response.json(over.configBody ?? config);
    if (url === "/api/arena/session") return Response.json({ token: "tok1", accountId: ACCOUNT, expiresAt: new Date(2_000_000).toISOString(), ...over.session });
    return new Response("nope", { status: 404 });
  });
  const now = over.now ?? (() => 1_000_000);
  const session = new ActionSession({ accountId: ACCOUNT, wallet, fetchImpl, now });
  return { session, wallet, signed, calls, fetchImpl, now };
}

describe("nonce", () => {
  it("is 32 bytes with the big-endian millisecond time first and random bytes after", () => {
    const n = makeNonce(1_700_000_000_123, (len) => new Uint8Array(len).fill(7));
    expect(n).toHaveLength(32);
    expect(Number(new DataView(n.buffer).getBigUint64(0, false))).toBe(1_700_000_000_123);
    expect([...n.slice(8)].every((b) => b === 7)).toBe(true);
    expect(makeNonce(1)).not.toEqual(makeNonce(1)); // real randomness differs
    expect(toBase64(new Uint8Array([1, 2, 3]))).toBe("AQID");
  });
});

describe("signing parameters", () => {
  it("come from the server and a malformed answer is refused", async () => {
    expect(await fetchSessionConfig(undefined, async () => Response.json(config))).toEqual({ readMessage: config.readMessage, sessionRecipient: "valtrum-read", actionRecipient: "valtrum-actions" });
    await expect(fetchSessionConfig(undefined, async () => Response.json({ ...config, sessionRecipient: 5 }))).rejects.toThrow(/malformed/);
    await expect(fetchSessionConfig(undefined, async () => Response.json({ error: "session configuration unavailable" }, { status: 503 }))).rejects.toThrow(/unavailable/);
  });
});

describe("read session", () => {
  it("signs the server's message for the server's recipient and keeps the token in memory", async () => {
    const h = harness();
    const before = JSON.stringify({ l: Object.keys(globalThis.localStorage ?? {}), s: Object.keys(globalThis.sessionStorage ?? {}) });
    expect(await h.session.ensure()).toBe("tok1");
    expect(h.signed[0]).toMatchObject({ message: config.readMessage, recipient: "valtrum-read" });
    expect(h.signed[0]!.nonce).toHaveLength(32);
    const post = h.fetchImpl.mock.calls.find((c) => c[0] === "/api/arena/session")!;
    expect(JSON.parse(post[1].body as string)).toMatchObject({ accountId: ACCOUNT, publicKey: "ed25519:k", signature: "c2ln" });
    // Nothing was persisted anywhere.
    expect(JSON.stringify({ l: Object.keys(globalThis.localStorage ?? {}), s: Object.keys(globalThis.sessionStorage ?? {}) })).toBe(before);
  });

  it("reuses a valid token, shares one wallet prompt between concurrent callers, and reopens near expiry", async () => {
    let t = 1_000_000;
    const h = harness({ now: () => t });
    const [a, b] = await Promise.all([h.session.ensure(), h.session.ensure()]);
    expect([a, b]).toEqual(["tok1", "tok1"]);
    expect(h.signed).toHaveLength(1);
    await h.session.ensure();
    expect(h.signed).toHaveLength(1);
    t = 2_000_000 - 30_000; // inside the refresh margin
    await h.session.ensure();
    expect(h.signed).toHaveLength(2);
  });

  it("refuses a signature or a session for another account, and a malformed response", async () => {
    await expect(harness({ wallet: { signMessage: async () => ({ accountId: "mallory.testnet", publicKey: "k", signature: "s" }) } }).session.ensure()).rejects.toThrow(/another account/);
    await expect(harness({ session: { accountId: "mallory.testnet" } }).session.ensure()).rejects.toThrow(/another account/);
    await expect(harness({ session: { token: 5 } }).session.ensure()).rejects.toThrow(/malformed/);
    await expect(harness({ session: { expiresAt: "not a date" } }).session.ensure()).rejects.toThrow(/malformed/);
  });

  it("surfaces a wallet rejection and lets the user retry, and forgets the token on invalidate", async () => {
    let reject = true;
    const h = harness({ wallet: { signMessage: async () => { if (reject) throw new Error("user rejected"); return { accountId: ACCOUNT, publicKey: "k", signature: "s" }; } } });
    await expect(h.session.ensure()).rejects.toThrow("user rejected");
    reject = false;
    expect(await h.session.ensure()).toBe("tok1");
    h.session.invalidate();
    await h.session.ensure();
    expect(h.fetchImpl.mock.calls.filter((c) => c[0] === "/api/arena/session")).toHaveLength(2);
  });
});

describe("action wallet", () => {
  const tx = { signerId: ACCOUNT, receiverId: "arena.testnet", actions: [{ type: "FunctionCall" as const, methodName: "create_lifecycle_battle", args: { a: 1 }, gas: "100000000000000", deposit: "1" }] };

  it("signs approvals for the action recipient and sends the prepared transaction exactly", async () => {
    const h = harness();
    const w = createActionWallet(h.session, { accountId: ACCOUNT, wallet: h.wallet });
    const proof = await w.signMessage("Authorize Valtrum action abc.");
    expect(h.signed.at(-1)).toMatchObject({ message: "Authorize Valtrum action abc.", recipient: "valtrum-actions" });
    expect(proof).toMatchObject({ accountId: ACCOUNT, publicKey: "ed25519:k", signature: "c2ln" });
    expect(atob(proof.nonce)).toHaveLength(32);
    const send = vi.spyOn(h.wallet, "signAndSendTransaction");
    expect(await w.signAndSend(tx)).toBe("TXHASH");
    expect(send).toHaveBeenCalledWith({ receiverId: "arena.testnet", actions: [{ type: "FunctionCall", params: { methodName: "create_lifecycle_battle", args: { a: 1 }, gas: "100000000000000", deposit: "1" } }] });
  });

  it("refuses when actions are not accepted, for another signer, for another account, or without a hash", async () => {
    const noActions = harness({ configBody: { ...config, actionRecipient: null } });
    await expect(createActionWallet(noActions.session, { accountId: ACCOUNT, wallet: noActions.wallet }).signMessage("m")).rejects.toThrow(/does not accept wallet actions/);
    const h = harness();
    const w = createActionWallet(h.session, { accountId: ACCOUNT, wallet: h.wallet });
    await expect(w.signAndSend({ ...tx, signerId: "mallory.testnet" })).rejects.toThrow(/another signer/);
    const other = harness({ wallet: { signMessage: async () => ({ accountId: "mallory.testnet", publicKey: "k", signature: "s" }) } });
    await expect(createActionWallet(other.session, { accountId: ACCOUNT, wallet: other.wallet }).signMessage("m")).rejects.toThrow(/another account/);
    const none = harness({ wallet: { signAndSendTransaction: async () => ({}) } });
    await expect(createActionWallet(none.session, { accountId: ACCOUNT, wallet: none.wallet }).signAndSend(tx)).rejects.toThrow(/transaction hash/);
    expect(txHashOf({ transaction_outcome: { id: "OID" } })).toBe("OID");
    expect(txHashOf(null)).toBeNull();
  });
});
