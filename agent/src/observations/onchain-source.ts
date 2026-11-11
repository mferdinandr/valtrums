import { createHash } from "node:crypto";
import type { CollectRound, RawSample, SampleSource } from "./collector.js";

/**
 * Live sample source (D39, owner choice 2026-11-11): Uniswap v3 `slot0` of each candidate's mainnet reference pool,
 * read at the latest block of Robinhood mainnet (chain 4663) through the local RPC relay, and priced in USD through
 * one WETH/USD pool. One JSON-RPC batch per sample: the latest block header and every needed `slot0`.
 *
 * - The price is exact: `sqrtPriceX96` and the token decimals are combined with BigInt only, then floored to
 *   `priceScale` fixed point. Nothing is rounded up, interpolated or reused.
 * - The observation time is the block timestamp (whole seconds) of the batch's latest block. The batch is answered
 *   by one node at once, so the calls and the header normally share a block; a skew of a block (about 0.1 s) is
 *   possible and is far below the boundary tolerance.
 * - The state is UNFINALIZED (latest block). The source name says so and every sample is `live`.
 * - Identity never comes from the pool: a pool is used only when its token pair is exactly {reference token, WETH}.
 */

const SEL_TOKEN0 = "0x0dfe1681";
const SEL_TOKEN1 = "0xd21220a7";
const SEL_DECIMALS = "0x313ce567";
const SEL_SLOT0 = "0x3850c7bd";
const Q192 = 1n << 192n;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type RpcItem = { id: number; result?: unknown; error?: unknown };

export interface OnchainSourceConfig {
  rpcUrl: string;
  /** Chain id of the reference tokens this source can price (Robinhood mainnet). */
  referenceChainId: string;
  wethAddress: string;
  /** WETH/USD-stablecoin pool used to convert WETH prices to USD. */
  usdPool: string;
  /** Candidate pools from the frozen observation terms (`eligible_pools`). */
  eligiblePools: readonly string[];
  priceScale: number;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

interface PoolMeta {
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
}

const lower = (s: string) => s.toLowerCase();
const word = (hex: string, i: number) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const asAddress = (hex: string) => (hex.length >= 66 ? `0x${word(hex, 0).slice(24)}` : "");

/** Price of `base` in the pool's other token as an exact fraction, from `sqrtPriceX96` and both decimals. */
export function poolPrice(sqrtPriceX96: bigint, baseIsToken0: boolean, decimals0: number, decimals1: number): { num: bigint; den: bigint } {
  if (sqrtPriceX96 <= 0n) throw new Error("pool has no price");
  const squared = sqrtPriceX96 * sqrtPriceX96;
  const t0 = 10n ** BigInt(decimals0);
  const t1 = 10n ** BigInt(decimals1);
  // raw ratio token1/token0 = squared / 2^192; human price of token0 in token1 = raw * 10^d0 / 10^d1.
  return baseIsToken0 ? { num: squared * t0, den: Q192 * t1 } : { num: Q192 * t1, den: squared * t0 };
}

/** floor(a * b * 10^scale) for two exact fractions, as a positive decimal string, or null when it floors to zero. */
export function scaledProduct(a: { num: bigint; den: bigint }, b: { num: bigint; den: bigint }, scale: number): string | null {
  const v = (a.num * b.num * 10n ** BigInt(scale)) / (a.den * b.den);
  return v > 0n ? v.toString() : null;
}

export class OnchainSlot0Source implements SampleSource {
  readonly name = "robinhood-4663-uniswap-v3-slot0-latest";
  readonly kind = "live" as const;
  private meta = new Map<string, PoolMeta>();
  private readonly cfg: Required<Omit<OnchainSourceConfig, "fetchImpl">> & { fetchImpl: FetchLike };

  constructor(cfg: OnchainSourceConfig) {
    this.cfg = { timeoutMs: 4_000, fetchImpl: (u, i) => fetch(u, i), ...cfg } as typeof this.cfg;
  }

  private async batch(calls: Array<{ method: string; params: unknown[] }>, signal?: AbortSignal): Promise<unknown[]> {
    const body = calls.map((c, id) => ({ jsonrpc: "2.0", id, method: c.method, params: c.params }));
    const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
    const res = await this.cfg.fetchImpl(this.cfg.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`reference RPC answered HTTP ${res.status}`);
    const json = (await res.json()) as RpcItem[] | RpcItem;
    const list = Array.isArray(json) ? json : [json];
    const out: unknown[] = new Array(calls.length).fill(undefined);
    for (const item of list) if (typeof item?.id === "number" && item.id < calls.length && item.error === undefined) out[item.id] = item.result;
    return out;
  }

  private ethCall(to: string, data: string) {
    return { method: "eth_call", params: [{ to, data }, "latest"] };
  }

  /** Token pair and decimals never change for a pool, so they are read once (two batches) and kept. */
  private async loadMeta(pools: string[], signal?: AbortSignal): Promise<void> {
    const missing = pools.filter((p) => !this.meta.has(p));
    if (missing.length === 0) return;
    const tokens = await this.batch(missing.flatMap((p) => [this.ethCall(p, SEL_TOKEN0), this.ethCall(p, SEL_TOKEN1)]), signal);
    const pairs = missing.flatMap((pool, i) => {
      const t0 = lower(asAddress(String(tokens[i * 2] ?? "")));
      const t1 = lower(asAddress(String(tokens[i * 2 + 1] ?? "")));
      return t0 && t1 ? [{ pool, t0, t1 }] : [];
    });
    if (pairs.length === 0) return;
    const decimals = await this.batch(pairs.flatMap((p) => [this.ethCall(p.t0, SEL_DECIMALS), this.ethCall(p.t1, SEL_DECIMALS)]), signal);
    pairs.forEach((p, i) => {
      const d0 = decimals[i * 2];
      const d1 = decimals[i * 2 + 1];
      if (typeof d0 !== "string" || typeof d1 !== "string" || d0.length < 3 || d1.length < 3) return;
      const decimals0 = Number(BigInt(d0));
      const decimals1 = Number(BigInt(d1));
      if (decimals0 > 36 || decimals1 > 36) return;
      this.meta.set(p.pool, { token0: p.t0, token1: p.t1, decimals0, decimals1 });
    });
  }

  /** The eligible pool whose pair is exactly {token, WETH}, or null. */
  private poolFor(token: string): string | null {
    const weth = lower(this.cfg.wethAddress);
    const t = lower(token);
    for (const pool of this.cfg.eligiblePools.map(lower)) {
      const m = this.meta.get(pool);
      if (m && ((m.token0 === t && m.token1 === weth) || (m.token1 === t && m.token0 === weth))) return pool;
    }
    return null;
  }

  async sample(round: CollectRound, signal?: AbortSignal): Promise<RawSample[]> {
    const usdPool = lower(this.cfg.usdPool);
    await this.loadMeta([...new Set([...this.cfg.eligiblePools.map(lower), usdPool])], signal);
    const usdMeta = this.meta.get(usdPool);
    if (!usdMeta || (usdMeta.token0 !== lower(this.cfg.wethAddress) && usdMeta.token1 !== lower(this.cfg.wethAddress))) {
      throw new Error("the WETH/USD pool is unreadable or does not hold WETH");
    }
    const wanted = round.candidates.flatMap((c) => {
      if (!c.reference || c.reference.chainId !== this.cfg.referenceChainId) return [];
      const pool = this.poolFor(c.reference.token);
      return pool ? [{ community: c.community, token: lower(c.reference.token), pool }] : [];
    });
    if (wanted.length === 0) return [];
    const pools = [...new Set(wanted.map((w) => w.pool))];
    const results = await this.batch(
      [{ method: "eth_getBlockByNumber", params: ["latest", false] }, ...pools.map((p) => this.ethCall(p, SEL_SLOT0)), this.ethCall(usdPool, SEL_SLOT0)],
      signal,
    );
    const block = results[0] as { number?: string; hash?: string; timestamp?: string } | undefined;
    if (!block?.number || !block.hash || !block.timestamp) throw new Error("the reference RPC returned no latest block");
    const observedAtMs = (BigInt(block.timestamp) * 1000n).toString();
    const sqrtOf = (hex: unknown): bigint | null => (typeof hex === "string" && hex.length >= 66 ? BigInt(`0x${word(hex, 0)}`) : null);
    const usdSqrt = sqrtOf(results[results.length - 1]);
    if (usdSqrt === null || usdSqrt === 0n) throw new Error("the WETH/USD pool returned no price");
    const weth = lower(this.cfg.wethAddress);
    const wethUsd = poolPrice(usdSqrt, usdMeta.token0 === weth, usdMeta.decimals0, usdMeta.decimals1);
    const out: RawSample[] = [];
    for (const w of wanted) {
      const sqrt = sqrtOf(results[1 + pools.indexOf(w.pool)]);
      const meta = this.meta.get(w.pool)!;
      if (sqrt === null || sqrt === 0n) continue; // missing data is omitted, never zero
      const tokenWeth = poolPrice(sqrt, meta.token0 === w.token, meta.decimals0, meta.decimals1);
      const price = scaledProduct(tokenWeth, wethUsd, this.cfg.priceScale);
      if (price === null) continue;
      const evidenceHash = createHash("sha256")
        .update(JSON.stringify([this.cfg.referenceChainId, block.number, block.hash, w.pool, sqrt.toString(), usdPool, usdSqrt.toString()]))
        .digest("hex");
      out.push({ community: w.community, price, priceScale: this.cfg.priceScale, observedAtMs, evidenceHash, pool: w.pool, quote: "USD" });
    }
    return out;
  }
}
