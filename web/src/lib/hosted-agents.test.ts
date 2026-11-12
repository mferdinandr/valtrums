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
