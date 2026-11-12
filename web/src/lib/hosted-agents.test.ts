import { describe, expect, it } from "vitest";
import { HostedAgentsClient, HostedAgentsError } from "./hosted-agents";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const wallet = { signMessage: async () => ({ accountId: "o.testnet", publicKey: "ed25519:pk", signature: "sig" }), signAndSendTransaction: async () => null };

describe("hosted agents client", () => {
  it("signs in with the wallet and always sends credentials, never a script-held token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const doFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/auth/challenge")) return json(200, { nonce: btoa("n".repeat(32)), message: "m", recipient: "r" });
      if (url.endsWith("/auth/verify")) return json(200, { owner: "o.testnet", expiresInMs: 1 });
      return json(200, { agents: [] });
    };
    const client = new HostedAgentsClient("https://svc.test", doFetch);
    await client.signIn(wallet, "o.testnet");
    expect(client.signedIn).toBe(true);
    expect(client.owner).toBe("o.testnet");
    await client.list();
    expect(calls.every((c) => c.init.credentials === "include")).toBe(true);
    expect(calls.some((c) => JSON.stringify(c.init.headers).toLowerCase().includes("authorization"))).toBe(false);
    expect(JSON.parse(calls[1]!.init.body as string)).toMatchObject({ accountId: "o.testnet", publicKey: "ed25519:pk", signature: "sig" });
  });

  it("restores the session after a reload from the service, and reports none when it has expired", async () => {
    const ok = new HostedAgentsClient("https://svc.test", async () => json(200, { owner: "o.testnet" }));
    expect(await ok.checkSession()).toBe("o.testnet");
    expect(ok.signedIn).toBe(true);
    const expired = new HostedAgentsClient("https://svc.test", async () => json(401, { error: "unauthorized", message: "sign in" }));
    expect(await expired.checkSession()).toBeNull();
    const down = new HostedAgentsClient("https://svc.test", async () => { throw new Error("offline"); });
    expect(await down.checkSession()).toBeNull();
  });

  it("surfaces service errors and drops the session on 401", async () => {
    const doFetch = async (url: string) =>
      url.endsWith("/auth/challenge") ? json(200, { nonce: btoa("n".repeat(32)), message: "m", recipient: "r" })
        : url.endsWith("/auth/verify") ? json(200, { owner: "o.testnet", expiresInMs: 1 })
        : json(401, { error: "unauthorized", message: "sign in with your wallet first" });
    const client = new HostedAgentsClient("https://svc.test", doFetch);
    await client.signIn(wallet, "o.testnet");
    await expect(client.list()).rejects.toBeInstanceOf(HostedAgentsError);
    expect(client.signedIn).toBe(false);
  });

  it("signs out on the service and locally", async () => {
    const paths: string[] = [];
    const client = new HostedAgentsClient("https://svc.test", async (url) => {
      paths.push(url);
      return json(200, { owner: "o.testnet", ok: true });
    });
    await client.checkSession();
    await client.signOut();
    expect(client.signedIn).toBe(false);
    expect(paths.at(-1)).toBe("https://svc.test/auth/logout");
  });

  it("does not store anything in the browser", () => {
    // No sessionStorage or localStorage use remains in the client source.
    expect(HostedAgentsClient.toString()).not.toMatch(/sessionStorage|localStorage/);
  });
});
