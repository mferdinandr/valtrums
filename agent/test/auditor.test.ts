import { describe, expect, it } from "vitest";
import {
  DexHeuristicHoneypotSimulator,
  DexLiquiditySource,
  type HoneypotSimulator,
  type LiquiditySource,
  MarketAuditor,
  auditAndAct,
} from "../src/auditor.js";
import { DexScreenerClient } from "../src/dexscreener.js";
import { FakeArenaClient, makeBattle } from "../src/fake-client.js";
import type { HttpClient } from "../src/http.js";

const liquidity = (m: Record<string, number>): LiquiditySource => ({
  async liquidityUsd(t) {
    return m[t] ?? 0;
  },
});
const honeypots = (bad: string[] = []): HoneypotSimulator => ({
  async check(t) {
    return { honeypot: bad.includes(t), detail: "sell simulation reverted" };
  },
});

function setup(liq: Record<string, number>, bad: string[] = []) {
  const client = new FakeArenaClient([makeBattle({ id: 1, token_a: "a.near", token_b: "b.near" })]);
  return { client, auditor: new MarketAuditor(liquidity(liq), honeypots(bad)) };
}

describe("market auditor", () => {
  it("approves when both tokens pass, and returns baselines", async () => {
    const { client, auditor } = setup({ "a.near": 50_000, "b.near": 10_001 });
    const out = await auditAndAct(client, auditor, 1);
    expect(out.action).toBe("approved");
    expect(client.calls).toEqual([{ method: "approve_battle", battleId: 1 }]);
    if (out.action === "approved") {
      expect(out.result.tokens.map((t) => t.liquidityUsd)).toEqual([50_000, 10_001]);
    }
  });

  it("voids with a liquidity reason at exactly $10,000", async () => {
    const { client, auditor } = setup({ "a.near": 50_000, "b.near": 10_000 });
    await auditAndAct(client, auditor, 1);
    const call = client.calls[0];
    expect(call?.method).toBe("void_battle");
    expect(call && "reason" in call && call.reason).toMatch(/low liquidity: b\.near/);
  });

  it("voids with a honeypot reason", async () => {
    const { client, auditor } = setup({ "a.near": 50_000, "b.near": 50_000 }, ["a.near"]);
    await auditAndAct(client, auditor, 1);
    const call = client.calls[0];
    expect(call && "reason" in call && call.reason).toMatch(/honeypot: a\.near/);
  });

  it("reports both reasons when both checks fail", async () => {
    const { client, auditor } = setup({ "a.near": 1, "b.near": 50_000 }, ["b.near"]);
    await auditAndAct(client, auditor, 1);
    const call = client.calls[0];
    const reason = call && "reason" in call ? call.reason : "";
    expect(reason).toMatch(/low liquidity/);
    expect(reason).toMatch(/honeypot/);
  });

  it("writes nothing when a data source fails", async () => {
    const { client } = setup({});
    const failing = new MarketAuditor(
      { liquidityUsd: async () => Promise.reject(new Error("api down")) },
      honeypots(),
    );
    await expect(auditAndAct(client, failing, 1)).rejects.toThrow("api down");
    expect(client.calls).toEqual([]);
    expect(client.status(1)).toBe("Proposed");
  });

  it("is idempotent: a repeated work item is skipped", async () => {
    const { client, auditor } = setup({ "a.near": 50_000, "b.near": 50_000 });
    await auditAndAct(client, auditor, 1);
    const again = await auditAndAct(client, auditor, 1);
    expect(again.action).toBe("skipped");
    expect(client.calls).toHaveLength(1);
  });
});

function pairsResponse(token: string, liq: number[], buys: number, sells: number) {
  return {
    pairs: liq.map((usd, i) => ({
      chainId: "near",
      dexId: "ref",
      pairAddress: `p${i}`,
      baseToken: { address: token },
      quoteToken: { address: "wrap.near" },
      priceUsd: "0.5",
      liquidity: { usd },
      txns: { h24: { buys, sells } },
    })),
  };
}

describe("DexScreener-backed checks", () => {
  const dex = (body: unknown) =>
    new DexScreenerClient({ http: { getJson: async () => body } as HttpClient });

  it("sums liquidity across pairs on the configured chain", async () => {
    const body = pairsResponse("a.near", [6_000, 5_000], 20, 20);
    body.pairs.push({ ...body.pairs[0]!, chainId: "ethereum", liquidity: { usd: 1e9 } });
    const src = new DexLiquiditySource(dex(body));
    expect(await src.liquidityUsd("a.near")).toBe(11_000);
  });

  it("flags buys without sells as a honeypot", async () => {
    const sim = new DexHeuristicHoneypotSimulator(dex(pairsResponse("a.near", [20_000], 40, 0)));
    expect((await sim.check("a.near")).honeypot).toBe(true);
  });

  it("does not flag a token with two-sided trading, or too little data", async () => {
    const ok = new DexHeuristicHoneypotSimulator(dex(pairsResponse("a.near", [20_000], 40, 12)));
    expect((await ok.check("a.near")).honeypot).toBe(false);
    const thin = new DexHeuristicHoneypotSimulator(dex(pairsResponse("a.near", [20_000], 3, 0)));
    expect((await thin.check("a.near")).honeypot).toBe(false);
  });

  it("flags a token with no pairs and treats null pairs as empty", async () => {
    const sim = new DexHeuristicHoneypotSimulator(dex({ pairs: null }));
    expect((await sim.check("a.near")).honeypot).toBe(true);
  });

  it("propagates HTTP failures", async () => {
    const failing = new DexScreenerClient({
      http: { getJson: async () => Promise.reject(new Error("status 503")) },
    });
    await expect(new DexLiquiditySource(failing).liquidityUsd("a.near")).rejects.toThrow("503");
  });

  it("sends the api key header only when configured", async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const http: HttpClient = {
      getJson: async (_u, h) => {
        seen.push(h);
        return { pairs: [] };
      },
    };
    await new DexScreenerClient({ http }).getPairs("a.near");
    await new DexScreenerClient({ http, apiKey: "k" }).getPairs("a.near");
    expect(seen).toEqual([{}, { "X-API-KEY": "k" }]);
  });
});
