import { describe, expect, it } from "vitest";
import { HostedAgentsClient, HostedAgentsError } from "./hosted-agents";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("hosted agents client", () => {
  it("signs in with the wallet and then sends the session token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const doFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/auth/challenge")) return json(200, { nonce: btoa("n".repeat(32)), message: "m", recipient: "r" });
      if (url.endsWith("/auth/verify")) return json(200, { token: "tok" });
      return json(200, { agents: [] });
    };
    const client = new HostedAgentsClient("https://svc.test", doFetch);
    const wallet = { signMessage: async () => ({ accountId: "o.testnet", publicKey: "ed25519:pk", signature: "sig" }), signAndSendTransaction: async () => null };
    await client.signIn(wallet, "o.testnet");
    expect(client.signedIn).toBe(true);
    await client.list();
    expect((calls.at(-1)!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const verify = JSON.parse(calls[1]!.init.body as string);
    expect(verify).toMatchObject({ accountId: "o.testnet", publicKey: "ed25519:pk", signature: "sig" });
  });

  const fakeStore = () => {
    const m = new Map<string, string>();
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  const signInFetch = (token: string) => async (url: string) =>
    url.endsWith("/auth/challenge") ? json(200, { nonce: btoa("n".repeat(32)), message: "m", recipient: "r" }) : json(200, { token });
  const wallet = { signMessage: async () => ({ accountId: "o.testnet", publicKey: "k", signature: "s" }), signAndSendTransaction: async () => null };

  it("keeps the session across a reload and forgets it on sign out", async () => {
    const store = fakeStore();
    const first = new HostedAgentsClient("https://svc.test", signInFetch("o.testnet.9999999999999.mac"), store, () => 1_000);
    await first.signIn(wallet, "o.testnet");
    const reloaded = new HostedAgentsClient("https://svc.test", signInFetch("x"), store, () => 2_000);
    expect(reloaded.signedIn).toBe(true);
    expect(reloaded.owner).toBe("o.testnet");
    reloaded.signOut();
    expect(new HostedAgentsClient("https://svc.test", signInFetch("x"), store, () => 2_000).signedIn).toBe(false);
  });

  it("does not restore an expired or malformed session", async () => {
    const expired = fakeStore();
    await new HostedAgentsClient("https://svc.test", signInFetch("o.testnet.5000.mac"), expired, () => 1_000).signIn(wallet, "o.testnet");
    expect(new HostedAgentsClient("https://svc.test", signInFetch("x"), expired, () => 6_000).signedIn).toBe(false);
    expect(expired.m.size).toBe(0);
    const bad = fakeStore();
    bad.setItem("valtrum.hosted-agents.session:https://svc.test", "{not json");
    expect(new HostedAgentsClient("https://svc.test", signInFetch("x"), bad, () => 1).signedIn).toBe(false);
  });

  it("surfaces service errors and drops the session on 401", async () => {
    const doFetch = async (url: string) =>
      url.endsWith("/auth/challenge") ? json(200, { nonce: btoa("n".repeat(32)), message: "m", recipient: "r" })
        : url.endsWith("/auth/verify") ? json(200, { token: "tok" })
        : json(401, { error: "unauthorized", message: "sign in with your wallet first" });
    const client = new HostedAgentsClient("https://svc.test", doFetch);
    await client.signIn({ signMessage: async () => ({ accountId: "o.testnet", publicKey: "k", signature: "s" }), signAndSendTransaction: async () => null }, "o.testnet");
    await expect(client.list()).rejects.toBeInstanceOf(HostedAgentsError);
    expect(client.signedIn).toBe(false);
  });
});
