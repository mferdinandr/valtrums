// FIXTURE-ONLY: fake funds, a fake round runner and generated keys. No network.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Challenges, nep413Digest, rpcKeyCheck, SIGN_IN_MESSAGE, SIGN_IN_RECIPIENT, verifyNep413 } from "../../src/hosted/auth.js";
import { decryptSecret, encryptSecret, issueSession, parseKek, readSession } from "../../src/hosted/crypto.js";

const KEK = parseKek("11".repeat(32));
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const toB58 = (bytes: Buffer): string => {
  let n = BigInt("0x" + bytes.toString("hex"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  return "1".repeat([...bytes].findIndex((b) => b !== 0)) + out;
};
const wallet = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { pk: `ed25519:${toB58(Buffer.from(raw))}`, signDigest: (d: Buffer) => sign(null, d, privateKey).toString("base64") };
};

describe("key custody", () => {
  it("round-trips a key and binds it to the account", () => {
    const blob = encryptSecret(KEK, "a1", "ed25519:secret");
    expect(blob).not.toContain("secret");
    expect(decryptSecret(KEK, "a1", blob)).toBe("ed25519:secret");
    expect(() => decryptSecret(KEK, "a2", blob)).toThrow();
    expect(() => decryptSecret(parseKek("22".repeat(32)), "a1", blob)).toThrow();
  });
  it("rejects a malformed KEK", () => {
    expect(() => parseKek("abc")).toThrow(/64 hex/);
    expect(() => parseKek(undefined)).toThrow();
  });
  it("issues sessions that expire and cannot be forged", () => {
    const t = issueSession(KEK, "owner.testnet", 1_000, 5_000);
    expect(readSession(KEK, t, 2_000)).toBe("owner.testnet");
    expect(readSession(KEK, t, 7_000)).toBeNull();
    expect(readSession(KEK, t.replace("owner.testnet", "other.testnet"), 2_000)).toBeNull();
    expect(readSession(parseKek("22".repeat(32)), t, 2_000)).toBeNull();
    expect(readSession(KEK, undefined, 2_000)).toBeNull();
  });
});

describe("owner proof (NEP-413)", () => {
  it("accepts a valid signature once and checks the key belongs to the account", async () => {
    const c = new Challenges(() => 1_000);
    const w = wallet();
    const ch = c.issue("owner.testnet");
    const sig = w.signDigest(nep413Digest(SIGN_IN_MESSAGE, Buffer.from(ch.nonce, "base64"), SIGN_IN_RECIPIENT));
    const proof = { account: "owner.testnet", publicKey: w.pk, signature: sig, nonce: ch.nonce };
    expect((await c.redeem(proof, async () => true)).ok).toBe(true);
    expect((await c.redeem(proof, async () => true)).ok).toBe(false); // spent
  });
  it("rejects a key that is not on the account, a bad signature and an expired nonce", async () => {
    let now = 1_000;
    const c = new Challenges(() => now);
    const w = wallet();
    const a = c.issue("owner.testnet");
    const sigA = w.signDigest(nep413Digest(SIGN_IN_MESSAGE, Buffer.from(a.nonce, "base64"), SIGN_IN_RECIPIENT));
    expect((await c.redeem({ account: "owner.testnet", publicKey: w.pk, signature: sigA, nonce: a.nonce }, async () => false)).ok).toBe(false);
    const b = c.issue("owner.testnet");
    expect((await c.redeem({ account: "owner.testnet", publicKey: w.pk, signature: randomBytes(64).toString("base64"), nonce: b.nonce }, async () => true)).ok).toBe(false);
    const d = c.issue("owner.testnet");
    const sigD = w.signDigest(nep413Digest(SIGN_IN_MESSAGE, Buffer.from(d.nonce, "base64"), SIGN_IN_RECIPIENT));
    now += 10 * 60_000;
    expect((await c.redeem({ account: "owner.testnet", publicKey: w.pk, signature: sigD, nonce: d.nonce }, async () => true)).ok).toBe(false);
  });
  it("does not accept a nonce issued to another account", async () => {
    const c = new Challenges(() => 1_000);
    const w = wallet();
    const ch = c.issue("alice.testnet");
    const sig = w.signDigest(nep413Digest(SIGN_IN_MESSAGE, Buffer.from(ch.nonce, "base64"), SIGN_IN_RECIPIENT));
    expect((await c.redeem({ account: "bob.testnet", publicKey: w.pk, signature: sig, nonce: ch.nonce }, async () => true)).ok).toBe(false);
  });
  it("names the step that failed, without leaking the proof", async () => {
    const c = new Challenges(() => 1_000);
    const w = wallet();
    const sign = (nonce: string) => w.signDigest(nep413Digest(SIGN_IN_MESSAGE, Buffer.from(nonce, "base64"), SIGN_IN_RECIPIENT));
    const reason = async (over: Partial<{ publicKey: string; signature: string; nonce: string }>, belongs = async () => true) => {
      const ch = c.issue("o.testnet");
      const r = await c.redeem({ account: "o.testnet", publicKey: w.pk, signature: sign(ch.nonce), nonce: ch.nonce, ...over }, belongs);
      return r.ok ? "ok" : r.reason;
    };
    expect(await reason({})).toBe("ok");
    expect(await reason({ nonce: Buffer.alloc(32, 1).toString("base64") })).toBe("challenge_unknown_or_expired");
    expect(await reason({ publicKey: "not a key!" })).toBe("bad_public_key_format");
    expect(await reason({ signature: "short" })).toBe("bad_signature_format");
    expect(await reason({ signature: randomBytes(64).toString("base64") })).toBe("signature_mismatch");
    expect(await reason({}, async () => false)).toBe("key_not_on_account");
    expect(await reason({}, async () => { throw new Error("RPC answered HTTP 429"); })).toMatch(/^rpc_error: RPC answered HTTP 429/);
  });

  it("accepts a public key without the ed25519: prefix and a base58 signature", async () => {
    const c = new Challenges(() => 1_000);
    const w = wallet();
    const ch = c.issue("o.testnet");
    const sig = Buffer.from(w.signDigest(nep413Digest(SIGN_IN_MESSAGE, Buffer.from(ch.nonce, "base64"), SIGN_IN_RECIPIENT)), "base64");
    const bare = w.pk.slice("ed25519:".length);
    expect((await c.redeem({ account: "o.testnet", publicKey: bare, signature: sig.toString("base64"), nonce: ch.nonce }, async () => true)).ok).toBe(true);
    const ch2 = c.issue("o.testnet");
    const sig2 = Buffer.from(w.signDigest(nep413Digest(SIGN_IN_MESSAGE, Buffer.from(ch2.nonce, "base64"), SIGN_IN_RECIPIENT)), "base64");
    expect((await c.redeem({ account: "o.testnet", publicKey: w.pk, signature: `ed25519:${toB58(sig2)}`, nonce: ch2.nonce }, async () => true)).ok).toBe(true);
  });

  it("verifyNep413 is false for garbage input", () => {
    expect(verifyNep413("nope", "x", Buffer.alloc(32))).toBe(false);
  });
});

describe("rpc access key check", () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("is true when the account lists the key", async () => {
    expect(await rpcKeyCheck("https://rpc.test", reply(200, { result: { permission: "FullAccess" } }))("a.testnet", "ed25519:K")).toBe(true);
  });
  it("is false for an unknown key or account, and throws when the RPC itself fails", async () => {
    expect(await rpcKeyCheck("https://rpc.test", reply(200, { error: { cause: { name: "UNKNOWN_ACCESS_KEY" } } }))("a.testnet", "ed25519:K")).toBe(false);
    expect(await rpcKeyCheck("https://rpc.test", reply(200, { error: { cause: { name: "UNKNOWN_ACCOUNT" } } }))("a.testnet", "ed25519:K")).toBe(false);
    await expect(rpcKeyCheck("https://rpc.test", reply(429, {}))("a.testnet", "ed25519:K")).rejects.toThrow(/HTTP 429/);
    await expect(rpcKeyCheck("https://rpc.test", reply(200, { error: { name: "HANDLER_ERROR", cause: { name: "UNAVAILABLE_SHARD" } } }))("a.testnet", "ed25519:K")).rejects.toThrow(/UNAVAILABLE_SHARD/);
  });
  it("adds the ed25519: prefix to a bare key before asking the RPC", async () => {
    let sent = "";
    const f = (async (_u: string, init: RequestInit) => { sent = JSON.parse(String(init.body)).params.public_key; return new Response(JSON.stringify({ result: { permission: "FullAccess" } })); }) as unknown as typeof fetch;
    await rpcKeyCheck("https://rpc.test", f)("a.testnet", "BARE");
    expect(sent).toBe("ed25519:BARE");
  });
});
