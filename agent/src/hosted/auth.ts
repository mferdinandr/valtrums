import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

/**
 * Owner proof for hosted agents: the caller signs a short-lived challenge with the connected NEAR wallet (NEP-413) and
 * the service checks the signature and that the signing key is an access key of the claimed account.
 */
export const SIGN_IN_RECIPIENT = "valtrum-hosted-agents";
export const SIGN_IN_MESSAGE = "Sign in to manage your hosted Valtrum agents (testnet)";
const NEP413_TAG = 2_147_484_061; // 2^31 + 413
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(text: string): Buffer {
  let n = 0n;
  for (const ch of text) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  const zeros = [...text].findIndex((c) => c !== "1");
  return Buffer.from([...new Array<number>(zeros < 0 ? text.length : zeros).fill(0), ...bytes]);
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const str = (s: string): Buffer => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([u32(b.length), b]);
};

/** The bytes a NEP-413 wallet signs: sha256 of the Borsh payload. */
export function nep413Digest(message: string, nonce: Buffer, recipient: string): Buffer {
  if (nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  return createHash("sha256").update(Buffer.concat([u32(NEP413_TAG), str(message), nonce, str(recipient), Buffer.from([0])])).digest();
}

/** `ed25519:<base58>` (or bare base58, which some wallets return) to the 32 raw bytes. */
export function parsePublicKey(text: string): Buffer {
  if (text.includes(":") && !text.startsWith("ed25519:")) throw new Error("only ed25519 keys are supported");
  const raw = base58(text.startsWith("ed25519:") ? text.slice(8) : text);
  if (raw.length !== 32) throw new Error("public key must be 32 bytes");
  return raw;
}

/** Wallets return the signature as base64 or as `ed25519:<base58>`. */
function parseSignature(text: string): Buffer {
  const sig = text.startsWith("ed25519:") ? base58(text.slice(8)) : Buffer.from(text, "base64");
  if (sig.length !== 64) throw new Error("signature must be 64 bytes");
  return sig;
}

/** Why a signature was not accepted: a malformed key or signature, or a signature that does not match the digest. */
export type SignatureProblem = "bad_public_key_format" | "bad_signature_format" | "signature_mismatch";

export function checkNep413(publicKey: string, signature: string, digest: Buffer): SignatureProblem | null {
  let raw: Buffer;
  let sig: Buffer;
  try {
    raw = parsePublicKey(publicKey);
  } catch {
    return "bad_public_key_format";
  }
  try {
    sig = parseSignature(signature);
  } catch {
    return "bad_signature_format";
  }
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, digest, key, sig) ? null : "signature_mismatch";
  } catch {
    return "signature_mismatch";
  }
}

export function verifyNep413(publicKey: string, signature: string, digest: Buffer): boolean {
  return checkNep413(publicKey, signature, digest) === null;
}

const CHALLENGE_TTL_MS = 5 * 60_000;

/** One-use challenges. A nonce is spent whether or not the proof verifies. */
export class Challenges {
  private readonly open = new Map<string, { nonce: Buffer; expires: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  issue(account: string): { nonce: string; message: string; recipient: string } {
    const now = this.now();
    for (const [k, v] of this.open) if (v.expires <= now) this.open.delete(k);
    const nonce = randomBytes(32);
    this.open.set(`${account}:${nonce.toString("base64")}`, { nonce, expires: now + CHALLENGE_TTL_MS });
    return { nonce: nonce.toString("base64"), message: SIGN_IN_MESSAGE, recipient: SIGN_IN_RECIPIENT };
  }

  /**
   * `ok: true` when the nonce was issued to this account, is unexpired, the signature matches and the key belongs to
   * the account. Otherwise the reason, which names the failing step and carries no secret.
   */
  async redeem(
    proof: { account: string; publicKey: string; signature: string; nonce: string },
    keyBelongsTo: (account: string, publicKey: string) => Promise<boolean>,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const id = `${proof.account}:${proof.nonce}`;
    const entry = this.open.get(id);
    this.open.delete(id);
    if (!entry || entry.expires <= this.now()) return { ok: false, reason: "challenge_unknown_or_expired" };
    const problem = checkNep413(proof.publicKey, proof.signature, nep413Digest(SIGN_IN_MESSAGE, entry.nonce, SIGN_IN_RECIPIENT));
    if (problem) return { ok: false, reason: problem };
    try {
      return (await keyBelongsTo(proof.account, proof.publicKey)) ? { ok: true } : { ok: false, reason: "key_not_on_account" };
    } catch (e) {
      return { ok: false, reason: `rpc_error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120) };
    }
  }
}

/**
 * Checks `view_access_key` over JSON-RPC: the account must list this key. A key the account does not have is `false`;
 * an RPC that cannot answer (HTTP error, rate limit, unknown failure) throws, so it is not mistaken for a bad key.
 */
export function rpcKeyCheck(rpcUrl: string, fetchImpl: typeof fetch = fetch) {
  return async (account: string, publicKey: string): Promise<boolean> => {
    const key = publicKey.startsWith("ed25519:") ? publicKey : `ed25519:${publicKey}`;
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "k", method: "query", params: { request_type: "view_access_key", finality: "final", account_id: account, public_key: key } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`RPC answered HTTP ${res.status}`);
    const body = (await res.json()) as { result?: { permission?: unknown }; error?: { cause?: { name?: string }; name?: string; message?: string; data?: unknown } };
    if (body.result?.permission !== undefined) return true;
    const cause = body.error?.cause?.name;
    // The account or the key does not exist: a real "no". Anything else is the RPC failing.
    if (cause === "UNKNOWN_ACCESS_KEY" || cause === "UNKNOWN_ACCOUNT") return false;
    throw new Error(`RPC error ${cause ?? body.error?.name ?? "without a result"}`);
  };
}
