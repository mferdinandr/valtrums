import { createHash, randomBytes } from "node:crypto";
import { issueSession, readSession } from "./crypto.js";
import type { Db } from "./db.js";

/** Owner sessions. The token travels in an `httpOnly` cookie; the page never reads it. */
export interface SessionStore {
  issue(owner: string, ttlMs: number): Promise<string>;
  /** The owner a valid, unexpired token belongs to, else null. */
  read(token: string | undefined): Promise<string | null>;
  revoke(token: string | undefined): Promise<void>;
}

/** Stateless signed tokens, used with the file repository. They cannot be revoked before they expire. */
export class HmacSessions implements SessionStore {
  constructor(private readonly kek: Buffer, private readonly now: () => number = Date.now) {}
  async issue(owner: string, ttlMs: number) {
    return issueSession(this.kek, owner, this.now(), ttlMs);
  }
  async read(token: string | undefined) {
    return readSession(this.kek, token, this.now());
  }
  async revoke() {}
}

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Sessions as rows. Only `sha256(token)` is stored, so a database read cannot be replayed as a session. */
export class DbSessions implements SessionStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}
  async issue(owner: string, ttlMs: number) {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    // Expired rows are removed on write, so the table does not grow without bound.
    await this.db.query("delete from public.hosted_sessions where expires_at <= $1", [new Date(now)]);
    await this.db.query("insert into public.hosted_sessions (token_hash, owner, created_at, expires_at) values ($1, $2, $3, $4)", [
      hash(token), owner, new Date(now), new Date(now + ttlMs),
    ]);
    return token;
  }
  async read(token: string | undefined) {
    if (!token) return null;
    const { rows } = await this.db.query<{ owner: string }>("select owner from public.hosted_sessions where token_hash = $1 and expires_at > $2", [hash(token), new Date(this.now())]);
    return rows[0]?.owner ?? null;
  }
  async revoke(token: string | undefined) {
    if (token) await this.db.query("delete from public.hosted_sessions where token_hash = $1", [hash(token)]);
  }
}
