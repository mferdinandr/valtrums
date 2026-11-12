import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Key custody for hosted testnet agents (OpenSpec `hosted-player-agents`). Agent secret keys are encrypted at rest with
 * AES-256-GCM under a key-encryption key (KEK) that lives in the environment, never in the store. The blob is
 * `v1.<iv>.<tag>.<ciphertext>` (base64url), and the agent account is bound in as authenticated data so a blob cannot be
 * moved to another agent.
 */
const VERSION = "v1";

export function parseKek(hex: string | undefined): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex.trim())) throw new Error("HOSTED_AGENT_KEK must be 64 hex characters (32 bytes)");
  return Buffer.from(hex.trim(), "hex");
}

export function encryptSecret(kek: Buffer, account: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  cipher.setAAD(Buffer.from(account));
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptSecret(kek: Buffer, account: string, blob: string): string {
  const [version, iv, tag, body] = blob.split(".");
  if (version !== VERSION || !iv || !tag || !body) throw new Error("stored key is malformed");
  const decipher = createDecipheriv("aes-256-gcm", kek, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(account));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

/** A session token `<account>.<expiresAtMs>.<mac>`, signed with a key derived from the KEK (not the KEK itself). */
const macKey = (kek: Buffer): Buffer => createHmac("sha256", kek).update("hosted-agent-session").digest();
const mac = (kek: Buffer, payload: string): string => createHmac("sha256", macKey(kek)).update(payload).digest("base64url");

export function issueSession(kek: Buffer, account: string, nowMs: number, ttlMs: number): string {
  const payload = `${account}.${nowMs + ttlMs}`;
  return `${payload}.${mac(kek, payload)}`;
}

/** The account a valid, unexpired token belongs to, else null. */
export function readSession(kek: Buffer, token: string | undefined, nowMs: number): string | null {
  if (!token) return null;
  const at = token.lastIndexOf(".");
  const dot = token.lastIndexOf(".", at - 1);
  if (at < 0 || dot < 0) return null;
  const account = token.slice(0, dot);
  const expires = Number(token.slice(dot + 1, at));
  const given = Buffer.from(token.slice(at + 1));
  const want = Buffer.from(mac(kek, token.slice(0, at)));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  return Number.isFinite(expires) && expires > nowMs ? account : null;
}
