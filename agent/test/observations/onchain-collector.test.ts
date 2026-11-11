// FIXTURE-ONLY: a fake JSON-RPC and fake arena views. No network, contract or provider.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CollectRound } from "../../src/observations/collector.js";
import { RecordedSampleSource } from "../../src/observations/collector.js";
import { CollectorRunner, type CollectorViews } from "../../src/observations/collector-main.js";
import { ObservationJournal, loadObservationState } from "../../src/observations/journal.js";
import { OnchainSlot0Source, poolPrice, scaledProduct } from "../../src/observations/onchain-source.js";
import type { ObservationTerms } from "../../src/lifecycle-oracle/config.js";
import { NS } from "./fixtures.js";

const Q96 = 1n << 96n;
const pad = (hex: string) => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;
const WETH = `0x${"e".repeat(40)}`;
const USDG = `0x${"d".repeat(40)}`;
const TOKEN = `0x${"a".repeat(40)}`;
const POOL = `0x${"1".repeat(40)}`;
const USD_POOL = `0x${"2".repeat(40)}`;

describe("exact pool price math", () => {
  it("prices token0 and token1 from sqrtPriceX96 and decimals", () => {
    // sqrtPrice 2 * 2^96: raw token1/token0 = 4.
    expect(poolPrice(2n * Q96, true, 18, 18)).toEqual({ num: 4n * Q96 * Q96 * 10n ** 18n, den: (1n << 192n) * 10n ** 18n });
    const inverse = poolPrice(2n * Q96, false, 18, 18);
    expect(scaledProduct(inverse, { num: 1n, den: 1n }, 18)).toBe("250000000000000000"); // 0.25
    // WETH (18) / USDG (6) with raw ratio 2000e6 / 1e18 => 2000 USD per WETH: sqrt is not exact, so use the fraction directly.
    expect(scaledProduct({ num: 1n, den: 2000n }, { num: 2000n, den: 1n }, 18)).toBe("1000000000000000000");
  });
  it("never rounds a tiny price up to a positive number", () => {
    expect(scaledProduct({ num: 1n, den: 10n ** 30n }, { num: 1n, den: 1n }, 18)).toBeNull();
    expect(() => poolPrice(0n, true, 18, 18)).toThrow(/no price/);
  });
});

/** A JSON-RPC batch endpoint for one token/WETH pool and one WETH/USDG pool. */
function fakeRpc(opts: { tokenSqrt: bigint; usdSqrt: bigint; blockTs: number; fail?: boolean }) {
  const calls: string[] = [];
  const answer = (method: string, params: Array<{ to?: string; data?: string } | string | boolean>): unknown => {
    if (method === "eth_getBlockByNumber") return { number: "0x10", hash: `0x${"b".repeat(64)}`, timestamp: `0x${opts.blockTs.toString(16)}` };
    const { to, data } = params[0] as { to: string; data: string };
    calls.push(`${to}:${data}`);
    if (data === "0x0dfe1681") return pad(to === POOL ? TOKEN : WETH); // token0
    if (data === "0xd21220a7") return pad(to === POOL ? WETH : USDG); // token1
    if (data === "0x313ce567") return pad((to === USDG ? 6 : 18).toString(16));
    if (data === "0x3850c7bd") return pad((to === POOL ? opts.tokenSqrt : opts.usdSqrt).toString(16)) + "0".repeat(64);
    return null;
  };
  const fetchImpl = async (_u: string, init: RequestInit) => {
    if (opts.fail) return new Response("down", { status: 502 });
    const body = JSON.parse(String(init.body)) as Array<{ id: number; method: string; params: never[] }>;
    return Response.json(body.map((b) => ({ jsonrpc: "2.0", id: b.id, result: answer(b.method, b.params) })));
  };
  return { fetchImpl, calls };
}

const round = (over: Partial<CollectRound> = {}): CollectRound => ({
  namespace: { ...NS }, battleId: "4", roundId: "1", mode: "PriceGain", policyHash: "policy", mappingVersion: "3",
  candidates: [
    { community: 0, asset: { chainId: "46630", token: `0x${"c".repeat(40)}` }, reference: { chainId: "4663", token: TOKEN } },
    { community: 1, asset: { chainId: "46630", token: `0x${"f".repeat(40)}` }, reference: null },
  ],
  startNs: "0", endNs: "0", boundaryToleranceMs: 5000, ...over,
});

describe("on-chain slot0 source", () => {
  const source = (rpc: ReturnType<typeof fakeRpc>) => new OnchainSlot0Source({
    rpcUrl: "http://relay", referenceChainId: "4663", wethAddress: WETH, usdPool: USD_POOL, eligiblePools: [POOL], priceScale: 18, fetchImpl: rpc.fetchImpl,
  });
  it("returns an exact USD price stamped with the block time, labelled live, only for priced references", async () => {
    // token in WETH: sqrt 2^96 => 1 WETH; WETH in USDG: raw ratio r with sqrt = 2^96 / 2 => r = 1/4, decimals 18/6 => 0.25e12 USD.
    const rpc = fakeRpc({ tokenSqrt: Q96, usdSqrt: Q96 / 2n, blockTs: 1_800_000_000 });
    const s = source(rpc);
    expect(s.kind).toBe("live");
    const samples = await s.sample(round());
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ community: 0, priceScale: 18, observedAtMs: "1800000000000", pool: POOL, quote: "USD" });
    expect(samples[0]!.price).toBe((250_000_000_000n * 10n ** 18n).toString());
    expect(samples[0]!.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("reads pool metadata once and then one batch per sample", async () => {
    const rpc = fakeRpc({ tokenSqrt: Q96, usdSqrt: Q96, blockTs: 1 });
    const s = source(rpc);
    await s.sample(round());
    const metaCalls = rpc.calls.filter((c) => !c.endsWith("0x3850c7bd")).length;
    await s.sample(round());
    expect(rpc.calls.filter((c) => !c.endsWith("0x3850c7bd")).length).toBe(metaCalls);
  });
  it("omits a pool without a price and surfaces an RPC outage as an error", async () => {
    expect(await source(fakeRpc({ tokenSqrt: 0n, usdSqrt: Q96, blockTs: 1 })).sample(round())).toEqual([]);
    await expect(source(fakeRpc({ tokenSqrt: Q96, usdSqrt: Q96, blockTs: 1, fail: true })).sample(round())).rejects.toThrow(/HTTP 502/);
  });
});

describe("collector runner", () => {
  let dir: string;
  let journal: ObservationJournal;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "obs-runner-")); journal = await ObservationJournal.open(dir); });
  afterEach(async () => { await journal.close(); await rm(dir, { recursive: true, force: true }); });

  const NOW = 1_800_000_010_000;
  const terms: ObservationTerms = {
    source: "s", quote_currency: "USD", eligible_pools: [POOL], finality: "latest", price_decimals: 18, supply_decimals: 18, volume_decimals: 18,
    boundary_tolerance_ns: "5000000000", max_gap_ns: "15000000000",
  };
  const views = (over: { locked?: boolean; startMs?: number | null; winner?: number | null } = {}): CollectorViews & { battles: number } => {
    const startMs = over.startMs === undefined ? NOW - 2_000 : over.startMs;
    const v = {
      battles: 0,
      count: async () => "1",
      battle: async () => {
        v.battles++;
        return {
          locked: over.locked ?? true, mode: "PriceGain" as const, observation_policy_hash: "policy",
          communities: [{ chain_id: "46630", token_address: `0x${"c".repeat(40)}`, reference_chain_id: "4663", reference_address: TOKEN }],
        };
      },
      round: async () => ({
        round_id: "1", candidates: [0], winner: over.winner ?? null,
        start_ns: startMs === null ? null : String(BigInt(startMs) * 1_000_000n),
        end_ns: startMs === null ? null : String(BigInt(startMs + 30_000) * 1_000_000n),
      }),
    };
    return v;
  };
  const runner = (v: CollectorViews) => new CollectorRunner(
    { scope: { ...NS }, terms: new Map([["policy", terms]]), mappingVersion: "3", qualifiedModes: new Set(["PriceGain"]) },
    {
      views: v, journal, now: () => NOW,
      sourceFor: () => new RecordedSampleSource("live-test", "recorded", [{ community: 0, price: "100", priceScale: 18, observedAtMs: String(NOW), evidenceHash: "e1", pool: POOL, quote: "USD" }]),
    },
  );

  it("samples a locked battle while its recorded window is open and persists the evidence", async () => {
    expect(await runner(views()).pass()).toBe(1);
    const state = (await loadObservationState(dir)).state;
    expect(state.observations).toHaveLength(1);
    expect(state.observations[0]!.observation).toMatchObject({ battleId: "1", roundId: "1", community: 0, mappingVersion: "3" });
  });
  it("skips unlocked battles and windows long past", async () => {
    expect(await runner(views({ locked: false })).pass()).toBe(0);
    expect(await runner(views({ startMs: NOW - 60_000 })).pass()).toBe(0);
  });
  it("samples a round whose window is not open yet, so the start the oracle records has a sample next to it", async () => {
    expect(await runner(views({ startMs: null })).pass()).toBe(1);
    expect((await loadObservationState(dir)).state.observations).toHaveLength(1);
  });
  it("reads a locked battle once and then only its round", async () => {
    const v = views();
    const r = runner(v);
    await r.pass();
    await r.pass();
    await r.pass();
    expect(v.battles).toBe(1);
  });
  it("stops reading a battle once its winner is recorded", async () => {
    const v = views({ winner: 0 });
    const r = runner(v);
    await r.pass();
    await r.pass();
    expect(v.battles).toBe(1);
  });
});
