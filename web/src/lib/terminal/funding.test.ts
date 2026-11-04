import { describe, expect, it, vi } from "vitest";
import { createMockFundingRouter } from "./funding";
import { createIntentsFundingRouter, createOneClickService } from "./oneclick";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("mock funding router", () => {
  it("quotes a fee, then executes the confirmed quote", async () => {
    const arrived: Array<[string, bigint]> = [];
    const r = createMockFundingRouter({ feeBps: 100, onArrived: (a, n) => arrived.push([a, n]) });
    const q = await r.quote({ chain: "base", amount: 15_000_000n, recipient: "a.testnet", refundTo: "0xabc123" });
    expect(q.feeUnits).toBe(150_000n);
    expect(q.minAmountOut).toBe(14_850_000n);
    expect(await r.execute(q)).toEqual({ ok: true, received: 14_850_000n });
    expect(arrived).toEqual([["a.testnet", 14_850_000n]]);
  });

  it("fails without crediting anything when told to fail or when the quote expired", async () => {
    let t = 0;
    const arrived: bigint[] = [];
    const r = createMockFundingRouter({ now: () => t, onArrived: (_a, n) => arrived.push(n) });
    const q = await r.quote({ chain: "base", amount: 1_000_000n, recipient: "a.testnet", refundTo: "0xabc123" });
    r.setFailure("down");
    expect(await r.execute(q)).toEqual({ ok: false, reason: "down" });
    r.setFailure(null);
    t = 11 * 60_000;
    expect(await r.execute(q)).toMatchObject({ ok: false });
    expect(arrived).toHaveLength(0);
  });
});

describe("1Click service", () => {
  const tokens = [
    { assetId: "nep141:base-usdc", symbol: "USDC", blockchain: "base", decimals: 6 },
    { assetId: "nep141:near-usdc", symbol: "USDC", blockchain: "near", decimals: 6 },
  ];

  it("resolves asset ids from /v0/tokens and posts a dry or committed quote", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown>; auth?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
        auth: (init?.headers as Record<string, string>).authorization,
      });
      if (url.endsWith("/v0/tokens")) return json(tokens);
      return json({ quote: { amountIn: "15000000", amountOut: "14900000", minAmountOut: "14800000", depositAddress: "0xdeposit", timeEstimate: 40, deadline: "2030-01-01T00:00:00Z" } });
    });
    const svc = createOneClickService({ baseUrl: "https://1c.example/", apiKey: "jwt", fetchImpl: fetchImpl as unknown as typeof fetch });
    const dry = await svc.quote({ chain: "base", amount: "15000000", recipient: "a.near", refundTo: "0xabc123", slippageBps: 50 }, false);
    expect(dry).toMatchObject({ amountIn: "15000000", minAmountOut: "14800000", depositAddress: null });
    const wet = await svc.quote({ chain: "base", amount: "15000000", recipient: "a.near", refundTo: "0xabc123", slippageBps: 50 }, true);
    expect(wet.depositAddress).toBe("0xdeposit");
    const quoteCalls = calls.filter((c) => c.url.endsWith("/v0/quote"));
    expect(quoteCalls[0]!.body).toMatchObject({ dry: true, swapType: "EXACT_INPUT", originAsset: "nep141:base-usdc", destinationAsset: "nep141:near-usdc", recipient: "a.near" });
    expect(quoteCalls[1]!.body).toMatchObject({ dry: false });
    expect(quoteCalls[0]!.auth).toBe("Bearer jwt");
    expect(calls.filter((c) => c.url.endsWith("/v0/tokens"))).toHaveLength(1); // cached
  });

  it("refuses chains it does not support", async () => {
    const svc = createOneClickService({ baseUrl: "https://1c.example", fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(svc.quote({ chain: "dogechain", amount: "1", recipient: "a.near", refundTo: "x", slippageBps: 1 }, false)).rejects.toThrow();
  });
});

describe("intents funding router (browser side)", () => {
  const req = { chain: "base", amount: 15_000_000n, recipient: "a.near", refundTo: "0xabc123" };
  const quoteBody = { amountIn: "15000000", minAmountOut: "14800000", etaSecs: 40, deadlineMs: Date.now() + 600_000, depositAddress: null };

  function router(statuses: string[]) {
    const queue = [...statuses];
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { action: string };
      if (body.action === "quote") return json(quoteBody);
      if (body.action === "commit") return json({ ...quoteBody, depositAddress: "0xdeposit" });
      return json({ status: queue.shift() ?? "PROCESSING", amountOut: "14800000" });
    });
    return createIntentsFundingRouter({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} });
  }

  it("shows fee from the quote, then polls until success", async () => {
    const r = router(["PENDING_DEPOSIT", "PROCESSING", "SUCCESS"]);
    const q = await r.quote(req);
    expect(q.feeUnits).toBe(200_000n);
    let address = "";
    expect(await r.execute(q, { onDepositAddress: (i) => (address = i.address) })).toEqual({ ok: true, received: 14_800_000n });
    expect(address).toBe("0xdeposit");
  });

  it.each(["FAILED", "REFUNDED", "INCOMPLETE_DEPOSIT"])("reports %s as a failure", async (status) => {
    const r = router([status]);
    const q = await r.quote(req);
    expect(await r.execute(q)).toMatchObject({ ok: false });
  });

  it("never throws on network errors", async () => {
    const r = createIntentsFundingRouter({
      fetchImpl: vi.fn(async (_u: string, init?: RequestInit) => {
        if ((JSON.parse(init!.body as string) as { action: string }).action === "quote") return json(quoteBody);
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    const q = await r.quote(req);
    expect(await r.execute(q)).toMatchObject({ ok: false, reason: "offline" });
  });
});
