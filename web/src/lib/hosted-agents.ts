import type { WalletLike } from "@/lib/arena-read/action-session";

/**
 * Client of the hosted testnet agent service (OpenSpec `hosted-player-agents`). The owner proves control of the wallet
 * once by signing a short-lived challenge (NEP-413); the service answers with a one-hour session token that is kept for
 * the tab (`sessionStorage`), so a reload does not sign the owner out. The key of a hosted agent never reaches the page
 * except through the explicit export call.
 */
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HostedAgentView {
  account: string;
  publicKey: string;
  style: "crowd" | "underdog";
  sweep: boolean;
  keepWhole: number;
  running: boolean;
  lastError: string | null;
  modelCalls: number;
  createdAt: number;
}

export class HostedAgentsError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

const bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** The minimal part of `sessionStorage` the client uses, so tests can pass a fake. */
export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const browserStore = (): SessionStore | null => {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null; // storage can be blocked; the session then lives in memory only
  }
};

export class HostedAgentsClient {
  private token: string | null = null;
  /** The wallet account the current session belongs to, or null when signed out. */
  owner: string | null = null;
  private readonly storageKey: string;

  /**
   * The session token is also kept in `sessionStorage` so a reload does not ask for the wallet again. It is per tab,
   * gone when the tab closes, and the service expires it after one hour. A token is only a session for one owner's
   * agents; the wallet still signs every fund transfer.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly doFetch: FetchLike = (u, i) => fetch(u, i),
    private readonly store: SessionStore | null = browserStore(),
    private readonly now: () => number = Date.now,
  ) {
    this.storageKey = `valtrum.hosted-agents.session:${baseUrl}`;
    this.restore();
  }

  private restore(): void {
    try {
      const saved = JSON.parse(this.store?.getItem(this.storageKey) ?? "null") as { token?: unknown; owner?: unknown } | null;
      if (typeof saved?.token !== "string" || typeof saved.owner !== "string") return;
      // The token is `<account>.<expiresAtMs>.<mac>`: skip one that has already expired.
      const expires = Number(saved.token.split(".").at(-2));
      if (Number.isFinite(expires) && expires > this.now()) {
        this.token = saved.token;
        this.owner = saved.owner;
      } else {
        this.store?.removeItem(this.storageKey);
      }
    } catch {
      // A malformed or unreadable entry just means signing in again.
    }
  }

  private persist(): void {
    try {
      if (this.token && this.owner) this.store?.setItem(this.storageKey, JSON.stringify({ token: this.token, owner: this.owner }));
      else this.store?.removeItem(this.storageKey);
    } catch {
      // Not saving is fine: the session still works until the page reloads.
    }
  }

  get signedIn(): boolean {
    return this.token !== null;
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...(init.auth !== false && this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string } & Record<string, unknown>;
    if (!res.ok) {
      if (res.status === 401) this.signOut();
      throw new HostedAgentsError(body.message ?? `request failed (${res.status})`, body.error ?? "error", res.status);
    }
    return body as T;
  }

  /** Sign in by signing a challenge with the connected wallet. */
  async signIn(wallet: WalletLike, accountId: string): Promise<void> {
    const ch = await this.request<{ nonce: string; message: string; recipient: string }>("/auth/challenge", { method: "POST", body: { accountId }, auth: false });
    const signed = await wallet.signMessage({ message: ch.message, recipient: ch.recipient, nonce: bytes(ch.nonce) });
    const out = await this.request<{ token: string }>("/auth/verify", {
      method: "POST",
      auth: false,
      body: { accountId: signed.accountId || accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: ch.nonce },
    });
    this.token = out.token;
    this.owner = signed.accountId || accountId;
    this.persist();
  }

  signOut(): void {
    this.token = null;
    this.owner = null;
    this.persist();
  }

  async list(): Promise<HostedAgentView[]> {
    return (await this.request<{ agents: HostedAgentView[] }>("/agents")).agents;
  }
  create(input: { style: "crowd" | "underdog"; sweep: boolean; keepWhole: number }): Promise<HostedAgentView> {
    return this.request("/agents", { method: "POST", body: input });
  }
  start(account: string): Promise<HostedAgentView> {
    return this.request(`/agents/${encodeURIComponent(account)}/start`, { method: "POST" });
  }
  stop(account: string): Promise<HostedAgentView> {
    return this.request(`/agents/${encodeURIComponent(account)}/stop`, { method: "POST" });
  }
  exportKey(account: string): Promise<{ account: string; secretKey: string }> {
    return this.request(`/agents/${encodeURIComponent(account)}/export`, { method: "POST" });
  }
}

let shared: HostedAgentsClient | null = null;
/**
 * One client per page load, so the session survives switching tabs or pages inside the app. A reload restores it from
 * `sessionStorage`; closing the tab or one hour of inactivity signs the owner out.
 */
export function getHostedClient(baseUrl: string): HostedAgentsClient {
  if (!shared) shared = new HostedAgentsClient(baseUrl);
  return shared;
}
