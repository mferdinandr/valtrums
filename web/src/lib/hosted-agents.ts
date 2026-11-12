import type { WalletLike } from "@/lib/arena-read/action-session";

/**
 * Client of the hosted testnet agent service (OpenSpec `hosted-player-agents`). The owner proves control of the wallet
 * once by signing a short-lived challenge (NEP-413); the service answers with a session token that is kept only in
 * memory, so closing the tab signs the owner out. The key of a hosted agent never reaches the page except through the
 * explicit export call.
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
  private token: string | null = null;
  constructor(private readonly baseUrl: string, private readonly doFetch: FetchLike = (u, i) => fetch(u, i)) {}

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
      if (res.status === 401) this.token = null;
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
  }

  signOut(): void {
    this.token = null;
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
