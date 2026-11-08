import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Read sessions bind account-scoped reads to a NEAR account proven by a NEP-413 signature from a
 * full-access key. A session token only selects whose data may be read: it carries no signing,
 * spending or delegation authority, and the server never holds a user key.
 */

export const READ_SESSION_MESSAGE = "Open a Valtrum read-only session. This grants no signing or spending authority.";

export interface SignedReadRequest {
  accountId: string;
  publicKey: string;
  /** Base64 signature over the NEP-413 payload. */
  signature: string;
  /** Base64 of the 32-byte nonce (first 8 bytes: big-endian ms timestamp). */
  nonce: string;
}

/** Verifies the signature and that the key is a full-access key of the account. */
export type Nep413Verifier = (
  signed: { accountId: string; publicKey: string; signature: string },
  params: { message: string; recipient: string; nonce: Uint8Array },
) => Promise<boolean>;

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export interface ReadSession {
  token: string;
  accountId: string;
  expiresAt: string;
}

export interface ReadSessionOptions {
  /** HMAC key for session tokens, at least 32 bytes, from a git-ignored env value. */
  secret: Uint8Array;
  /** NEP-413 recipient the client must sign for (the read service identity). */
  recipient: string;
  verify: Nep413Verifier;
  now?: () => number;
  ttlMs?: number;
  maxNonceAgeMs?: number;
}

const ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export class ReadSessions {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxNonceAgeMs: number;
  /** Used nonces until they could no longer pass the age check. */
  private readonly usedNonces = new Map<string, number>();

  constructor(private readonly opts: ReadSessionOptions) {
    if (opts.secret.length < 32) throw new Error("read session secret must be at least 32 bytes");
    if (!opts.recipient.trim()) throw new Error("read session recipient is required");
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
    this.maxNonceAgeMs = opts.maxNonceAgeMs ?? 5 * 60 * 1000;
  }

  async open(req: SignedReadRequest): Promise<ReadSession> {
    if (typeof req?.accountId !== "string" || !ACCOUNT.test(req.accountId)) throw new SessionError("invalid account id");
    if (typeof req.publicKey !== "string" || typeof req.signature !== "string" || typeof req.nonce !== "string") {
      throw new SessionError("malformed signed request");
    }
    const nonce = new Uint8Array(Buffer.from(req.nonce, "base64"));
    if (nonce.length !== 32) throw new SessionError("nonce must be 32 bytes");
    const now = this.now();
    const issued = Number(new DataView(nonce.buffer, nonce.byteOffset, 8).getBigUint64(0, false));
    if (now - issued > this.maxNonceAgeMs || issued - now > 30_000) throw new SessionError("nonce expired or from the future");
    this.pruneNonces(now);
    const nonceKey = bytesToHex(nonce);
    if (this.usedNonces.has(nonceKey)) throw new SessionError("nonce already used");

    let ok = false;
    try {
      ok = await this.opts.verify(
        { accountId: req.accountId, publicKey: req.publicKey, signature: req.signature },
        { message: READ_SESSION_MESSAGE, recipient: this.opts.recipient, nonce },
      );
    } catch {
      ok = false;
    }
    if (!ok) throw new SessionError("signature is not from a full-access key of this account");
    this.usedNonces.set(nonceKey, issued + this.maxNonceAgeMs);

    const expiresAtMs = now + this.ttlMs;
    const payload = b64url(utf8ToBytes(JSON.stringify({ a: req.accountId, e: expiresAtMs, s: bytesToHex(randomBytes(8)) })));
    return { token: `${payload}.${this.mac(payload)}`, accountId: req.accountId, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /** Returns the account a token is bound to; throws on any tampered, malformed or expired token. */
  accountOf(token: unknown): string {
    if (typeof token !== "string" || token.length > 1024) throw new SessionError("missing read session");
    const [payload, mac, extra] = token.split(".");
    if (!payload || !mac || extra !== undefined) throw new SessionError("malformed read session");
    if (!sameBytes(utf8ToBytes(mac), utf8ToBytes(this.mac(payload)))) throw new SessionError("invalid read session");
    let body: { a?: unknown; e?: unknown };
    try {
      body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { a?: unknown; e?: unknown };
    } catch {
      throw new SessionError("malformed read session");
    }
    if (typeof body.a !== "string" || typeof body.e !== "number") throw new SessionError("malformed read session");
    if (this.now() >= body.e) throw new SessionError("read session expired");
    return body.a;
  }

  private mac(payload: string): string {
    return bytesToHex(hmac(sha256, this.opts.secret, utf8ToBytes(payload)));
  }

  private pruneNonces(now: number): void {
    for (const [k, until] of this.usedNonces) if (until < now) this.usedNonces.delete(k);
  }
}
