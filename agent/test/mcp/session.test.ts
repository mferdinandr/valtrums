import { describe, expect, it } from "vitest";
import { READ_SESSION_MESSAGE, ReadSessions } from "../../src/mcp/session.js";
import { NOW, RECIPIENT, makeSessions, signRead } from "./fixtures.js";

describe("NEP-413 read sessions", () => {
  it("opens a session bound to the signing account", async () => {
    const s = makeSessions();
    const session = await s.open(signRead("alice.testnet"));
    expect(session.accountId).toBe("alice.testnet");
    expect(s.accountOf(session.token)).toBe("alice.testnet");
  });

  it("refuses a signature for another message, recipient or account", async () => {
    const s = makeSessions();
    await expect(s.open(signRead("alice.testnet", { message: "something else" }))).rejects.toThrow("full-access key");
    await expect(s.open(signRead("alice.testnet", { recipient: "evil.app" }))).rejects.toThrow("full-access key");
    const signed = signRead("alice.testnet");
    await expect(s.open({ ...signed, accountId: "bob.testnet" })).rejects.toThrow("full-access key");
  });

  it("refuses a replayed, expired or future nonce", async () => {
    const s = makeSessions();
    const signed = signRead("alice.testnet");
    await s.open(signed);
    await expect(s.open(signed)).rejects.toThrow("nonce already used");
    await expect(s.open(signRead("alice.testnet", { at: NOW - 10 * 60_000 }))).rejects.toThrow("nonce expired");
    await expect(s.open(signRead("alice.testnet", { at: NOW + 10 * 60_000 }))).rejects.toThrow("nonce expired");
  });

  it("refuses when the key is not a full-access key of the account", async () => {
    const s = new ReadSessions({ secret: new Uint8Array(32), recipient: RECIPIENT, now: () => NOW, verify: async () => false });
    await expect(s.open(signRead("alice.testnet"))).rejects.toThrow("full-access key");
    const throwing = new ReadSessions({ secret: new Uint8Array(32), recipient: RECIPIENT, now: () => NOW, verify: async () => { throw new Error("rpc down"); } });
    await expect(throwing.open(signRead("alice.testnet"))).rejects.toThrow("full-access key");
  });

  it("rejects tampered, foreign, malformed and expired tokens", async () => {
    let now = NOW;
    const s = makeSessions(() => now);
    const { token } = await s.open(signRead("alice.testnet"));
    const [payload, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ a: "bob.testnet", e: NOW + 1e9, s: "x" })).toString("base64url");
    expect(() => s.accountOf(`${forged}.${mac}`)).toThrow("invalid read session");
    expect(() => s.accountOf(`${payload}.${"0".repeat(64)}`)).toThrow("invalid read session");
    expect(() => s.accountOf(undefined)).toThrow("missing read session");
    expect(() => s.accountOf("a.b.c")).toThrow("malformed");
    const other = new ReadSessions({ secret: new Uint8Array(32).fill(9), recipient: RECIPIENT, now: () => NOW, verify: async () => true });
    expect(() => other.accountOf(token)).toThrow("invalid read session");
    now = NOW + 2 * 60 * 60 * 1000;
    expect(() => s.accountOf(token)).toThrow("expired");
  });

  it("states in the signed message that the session grants no spending authority", () => {
    expect(READ_SESSION_MESSAGE).toMatch(/no signing or spending authority/);
  });
});
