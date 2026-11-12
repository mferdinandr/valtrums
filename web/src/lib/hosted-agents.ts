import type { WalletLike } from "@/lib/arena-read/action-session";

/**
 * Client of the hosted testnet agent service (OpenSpec `hosted-player-agents`, `hosted-agents-database`). The owner
 * proves control of the wallet once by signing a short-lived challenge (NEP-413). The service answers with an
 * `httpOnly` session cookie, so no token is ever readable by page scripts and a reload keeps the session. The key of a
 * hosted agent never reaches the page except through the explicit export call.
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

export class HostedAgentsClient {
  /** The wallet account the current session belongs to, or null when signed out or not yet checked. */
  owner: string | null = null;

  constructor(private readonly baseUrl: string, private readonly doFetch: FetchLike = (u, i) => fetch(u, i)) {}

  get signedIn(): boolean {
    return this.owner !== null;
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      // The cookie is the session; the browser sends it, the page cannot read it.
      credentials: "include",
      headers: { "content-type": "application/json" },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string } & Record<string, unknown>;
    if (!res.ok) {
      if (res.status === 401) this.owner = null;
      throw new HostedAgentsError(body.message ?? `request failed (${res.status})`, body.error ?? "error", res.status);
    }
    return body as T;
  }

  /** Asks the service whether the cookie is still a valid session (after a reload). Never throws. */
  async checkSession(): Promise<string | null> {
    try {
      this.owner = (await this.request<{ owner: string }>("/auth/session")).owner;
    } catch {
      this.owner = null;
    }
    return this.owner;
  }

  /** Sign in by signing a challenge with the connected wallet. */
  async signIn(wallet: WalletLike, accountId: string): Promise<void> {
    const ch = await this.request<{ nonce: string; message: string; recipient: string }>("/auth/challenge", { method: "POST", body: { accountId } });
    const signed = await wallet.signMessage({ message: ch.message, recipient: ch.recipient, nonce: bytes(ch.nonce) });
    const out = await this.request<{ owner: string }>("/auth/verify", {
      method: "POST",
      body: { accountId: signed.accountId || accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: ch.nonce },
    });
    this.owner = out.owner;
  }

  /** Ends the session on the service and clears the cookie. */
  async signOut(): Promise<void> {
    this.owner = null;
    await this.request("/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
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
/** One client per page load, so switching tabs or pages inside the app keeps the checked session. */
export function getHostedClient(baseUrl: string): HostedAgentsClient {
  if (!shared) shared = new HostedAgentsClient(baseUrl);
  return shared;
}
