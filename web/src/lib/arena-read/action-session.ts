import type { ActionWallet, UnsignedTransaction } from "@/lib/terminal/actions";

/**
 * Client side of the NEP-413 read/action session. The wallet signs messages whose text and recipients
 * come from the read service (`/api/arena/session/config`), never from this bundle. The session token
 * selects whose data may be read and lets that account authorize its own action previews; it carries
 * no signing or spending authority (each transaction needs the wallet's signature). It is kept in the
 * tab's sessionStorage until it expires (cleared when the tab closes), never in localStorage, a cookie
 * or a URL.
 */

export interface SessionConfig {
  readMessage: string;
  sessionRecipient: string;
  actionRecipient: string | null;
}

/** The slice of the wallet connector this module needs. Injected, so it can be tested without a wallet. */
export interface WalletLike {
  signMessage(params: { message: string; recipient: string; nonce: Uint8Array }): Promise<{ accountId: string; publicKey: string; signature: string }>;
  signAndSendTransaction(params: {
    receiverId: string;
    actions: Array<{ type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } }>;
  }): Promise<unknown>;
  /** Several transactions under one approval. Not every wallet offers it; callers fall back to one at a time. */
  signAndSendTransactions?(params: {
    transactions: Array<{
      receiverId: string;
      actions: Array<{ type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } }>;
    }>;
  }): Promise<unknown>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class SessionClientError extends Error {
  constructor(message: string, readonly status: number | null = null) { super(message); }
}

export async function fetchSessionConfig(signal?: AbortSignal, doFetch: FetchLike = (u, i) => fetch(u, i)): Promise<SessionConfig> {
  const res = await doFetch("/api/arena/session/config", { method: "GET", cache: "no-store", ...(signal ? { signal } : {}) });
  const body = (await res.json().catch(() => null)) as { error?: string; readMessage?: unknown; sessionRecipient?: unknown; actionRecipient?: unknown } | null;
  if (!res.ok || !body) throw new SessionClientError(body?.error ?? "signing parameters unavailable", res.status);
  if (typeof body.readMessage !== "string" || typeof body.sessionRecipient !== "string" || !(body.actionRecipient === null || typeof body.actionRecipient === "string")) {
    throw new SessionClientError("signing parameters are malformed", res.status);
  }
  return { readMessage: body.readMessage, sessionRecipient: body.sessionRecipient, actionRecipient: body.actionRecipient };
}

/** 32 bytes: the first 8 are the big-endian millisecond timestamp the server checks for freshness, the rest are random. */
export function makeNonce(nowMs: number, random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): Uint8Array {
  const out = new Uint8Array(32);
  new DataView(out.buffer).setBigUint64(0, BigInt(Math.trunc(nowMs)), false);
  out.set(random(24), 8);
  return out;
}

export const toBase64 = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/** Minimal storage slice (sessionStorage in the browser), injected so tests need no DOM. */
export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORE_PREFIX = "valtrum.session.";

/** The tab's sessionStorage, or null where it is unavailable (server render, blocked storage). */
function browserSessionStore(): SessionStore | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/**
 * Removes every stored session token in this tab. Called when the service rejects a token (for example
 * after its signing secret changed), so the next action opens a fresh session instead of reusing it.
 */
export function forgetStoredSessions(store: SessionStore | null = browserSessionStore()): void {
  if (!store) return;
  try {
    const keys: string[] = [];
    const s = store as SessionStore & { length?: number; key?: (i: number) => string | null };
    if (typeof s.length === "number" && typeof s.key === "function") {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k?.startsWith(STORE_PREFIX)) keys.push(k);
      }
    }
    for (const k of keys) store.removeItem(k);
  } catch { /* storage unavailable */ }
}

/**
 * Session for one connected account. The token is kept in this tab's sessionStorage until it expires,
 * so a page reload does not ask the wallet to sign again; it is cleared when the tab closes, on
 * sign-out, on a 401 and on an account change. The token cannot sign or move funds: every transaction
 * still needs the wallet's own signature.
 */
export class ActionSession {
  private token: string | null = null;
  private expiresAtMs = 0;
  private opening: Promise<string> | null = null;
  private config: SessionConfig | null = null;
  private readonly store: SessionStore | null;

  constructor(private readonly deps: {
    accountId: string;
    wallet: WalletLike;
    fetchImpl?: FetchLike;
    now?: () => number;
    /** Reopen when fewer than this many ms remain. */
    refreshMarginMs?: number;
    /** Where the token survives a reload; defaults to the tab's sessionStorage. `null` keeps it in memory only. */
    store?: SessionStore | null;
  }) {
    this.store = deps.store === undefined ? browserSessionStore() : deps.store;
    this.restore();
  }

  private get storeKey(): string { return `${STORE_PREFIX}${this.deps.accountId}`; }

  /** Picks up an unexpired token this tab saved for the same account; anything else is discarded. */
  private restore(): void {
    try {
      const raw = this.store?.getItem(this.storeKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as { accountId?: unknown; token?: unknown; expiresAtMs?: unknown };
      if (saved.accountId === this.deps.accountId && typeof saved.token === "string" && typeof saved.expiresAtMs === "number" && saved.expiresAtMs > this.now) {
        this.token = saved.token;
        this.expiresAtMs = saved.expiresAtMs;
        this.stored = true;
      } else {
        this.store?.removeItem(this.storeKey);
      }
    } catch {
      try { this.store?.removeItem(this.storeKey); } catch { /* storage unavailable */ }
    }
  }

  /** True when the token is (or was restored from) this tab's storage, so a removed entry means "forgotten". */
  private stored = false;

  private persist(): void {
    try {
      if (this.token) {
        this.store?.setItem(this.storeKey, JSON.stringify({ accountId: this.deps.accountId, token: this.token, expiresAtMs: this.expiresAtMs }));
        this.stored = !!this.store;
      } else {
        this.store?.removeItem(this.storeKey);
        this.stored = false;
      }
    } catch {
      // Storage unavailable or full: the session still works in memory for this page.
      this.stored = false;
    }
  }

  /** The stored entry was removed elsewhere (a rejected token, see `forgetStoredSessions`): drop the token too. */
  private forgottenElsewhere(): boolean {
    if (!this.stored || !this.token) return false;
    try {
      return this.store?.getItem(this.storeKey) === null;
    } catch {
      return false;
    }
  }

  private get now(): number { return (this.deps.now ?? Date.now)(); }
  private get doFetch(): FetchLike { return this.deps.fetchImpl ?? ((u, i) => fetch(u, i)); }

  async signingConfig(): Promise<SessionConfig> {
    // Read from the server once per session (a new session re-reads it): the server owns these values.
    return (this.config ??= await fetchSessionConfig(undefined, this.doFetch));
  }

  /** A valid token, opening a session (one wallet signature) when there is none. Concurrent calls share one prompt. */
  ensure(): Promise<string> {
    if (this.forgottenElsewhere()) this.invalidate();
    if (this.token && this.now < this.expiresAtMs - (this.deps.refreshMarginMs ?? 60_000)) return Promise.resolve(this.token);
    return (this.opening ??= this.open().finally(() => { this.opening = null; }));
  }

  /** Forget the token (sign-out, a 401 from the server, or an account change). */
  invalidate(): void {
    this.token = null;
    this.expiresAtMs = 0;
    this.config = null;
    this.persist();
  }

  private async open(): Promise<string> {
    this.config = null;
    const cfg = await this.signingConfig();
    const nonce = makeNonce(this.now);
    const signed = await this.deps.wallet.signMessage({ message: cfg.readMessage, recipient: cfg.sessionRecipient, nonce });
    if (signed.accountId !== this.deps.accountId) throw new SessionClientError("the wallet signed for another account than the connected one");
    const res = await this.doFetch("/api/arena/session", {
      method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: toBase64(nonce) }),
    });
    const body = (await res.json().catch(() => null)) as { error?: string; token?: unknown; accountId?: unknown; expiresAt?: unknown } | null;
    if (!res.ok || !body) throw new SessionClientError(body?.error ?? "could not open a session", res.status);
    const expires = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : NaN;
    if (typeof body.token !== "string" || body.accountId !== this.deps.accountId || !Number.isFinite(expires)) {
      throw new SessionClientError("the session response is malformed or for another account", res.status);
    }
    this.token = body.token;
    this.expiresAtMs = expires;
    this.persist();
    return body.token;
  }
}

/** The transaction hash of a wallet outcome, or null when the wallet returned something else. */
export function txHashOf(outcome: unknown): string | null {
  const o = outcome as { transaction?: { hash?: unknown }; transaction_outcome?: { id?: unknown } } | null;
  const hash = o?.transaction?.hash ?? o?.transaction_outcome?.id;
  return typeof hash === "string" && hash.length > 0 ? hash : null;
}

/**
 * `ActionWallet` for the shared action boundary (`runTerminalAction`). Approval messages are signed for
 * the action recipient the server published; the prepared transaction is signed and sent exactly as the
 * server returned it, for the connected account only.
 */
export function createActionWallet(session: ActionSession, deps: { accountId: string; wallet: WalletLike; now?: () => number }): ActionWallet {
  return {
    async signMessage(message: string) {
      const cfg = await session.signingConfig();
      if (!cfg.actionRecipient) throw new SessionClientError("this deployment does not accept wallet actions");
      const nonce = makeNonce((deps.now ?? Date.now)());
      const signed = await deps.wallet.signMessage({ message, recipient: cfg.actionRecipient, nonce });
      if (signed.accountId !== deps.accountId) throw new SessionClientError("the wallet signed for another account than the connected one");
      return { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: toBase64(nonce) };
    },
    async signAndSend(tx: UnsignedTransaction) {
      if (tx.signerId !== deps.accountId) throw new SessionClientError("the prepared transaction is for another signer");
      const outcome = await deps.wallet.signAndSendTransaction({
        receiverId: tx.receiverId,
        actions: tx.actions.map((a) => ({ type: "FunctionCall" as const, params: { methodName: a.methodName, args: a.args, gas: a.gas, deposit: a.deposit } })),
      });
      const hash = txHashOf(outcome);
      if (!hash) throw new SessionClientError("the wallet did not return a transaction hash");
      return hash;
    },
  };
}
