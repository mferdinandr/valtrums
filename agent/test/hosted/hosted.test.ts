// FIXTURE-ONLY: fake funds, a fake round runner and generated keys. No network.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Challenges, nep413Digest, SIGN_IN_MESSAGE, SIGN_IN_RECIPIENT, verifyNep413 } from "../../src/hosted/auth.js";
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
    expect(await c.redeem(proof, async () => true)).toBe(true);
    expect(await c.redeem(proof, async () => true)).toBe(false); // spent
  });
  it("rejects a key that is not on the account, a bad signature and an expired nonce", async () => {
    let now = 1_000;
    const c = new Challenges(() => now);
    const w = wallet();
    const a = c.issue("owner.testnet");
    const sigA = w.signDigest(nep413Digest(SIGN_IN_MESSAGE, Buffer.from(a.nonce, "base64"), SIGN_IN_RECIPIENT));
    expect(await c.redeem({ account: "owner.testnet", publicKey: w.pk, signature: sigA, nonce: a.nonce }, async () => false)).toBe(false);
    const b = c.issue("owner.testnet");
    expect(await c.redeem({ account: "owner.testnet", publicKey: w.pk, signature: randomBytes(64).toString("base64"), nonce: b.nonce }, async () => true)).toBe(false);
    const d = c.issue("owner.testnet");
    const sigD = w.signDigest(nep413Digest(SIGN_IN_MESSAGE, Buffer.from(d.nonce, "base64"), SIGN_IN_RECIPIENT));
    now += 10 * 60_000;
    expect(await c.redeem({ account: "owner.testnet", publicKey: w.pk, signature: sigD, nonce: d.nonce }, async () => true)).toBe(false);
  });
  it("does not accept a nonce issued to another account", async () => {
    const c = new Challenges(() => 1_000);
    const w = wallet();
    const ch = c.issue("alice.testnet");
    const sig = w.signDigest(nep413Digest(SIGN_IN_MESSAGE, Buffer.from(ch.nonce, "base64"), SIGN_IN_RECIPIENT));
    expect(await c.redeem({ account: "bob.testnet", publicKey: w.pk, signature: sig, nonce: ch.nonce }, async () => true)).toBe(false);
  });
  it("verifyNep413 is false for garbage input", () => {
    expect(verifyNep413("nope", "x", Buffer.alloc(32))).toBe(false);
  });
});

