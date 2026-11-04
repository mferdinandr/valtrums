import type { ArenaClient } from "./client.js";
import type { DexScreenerClient } from "./dexscreener.js";
import { type BackoffOptions, withBackoff } from "./retry.js";
import type { BattleView } from "./types.js";

/** Prices are USD per whole coin scaled by 1e18, as u128. */
export const PRICE_SCALE_DECIMALS = 18;
export const U128_MAX = (1n << 128n) - 1n;
export const TWAP_WINDOW_MS = 30 * 60 * 1000;

export interface PriceSample {
  tsMs: number;
  price: bigint;
}

/** Supplies price observations for a time window. Swap in an indexer with real history if available. */
export interface PriceSource {
  samples(token: string, fromMs: number, toMs: number): Promise<PriceSample[]>;
}

export class InsufficientSamplesError extends Error {}

/**
 * Parse a non-negative decimal string ("0.000001234", "1.2e-7") into a bigint
 * scaled by 1e18, truncating digits beyond 18 decimals.
 */
export function parseUsdPrice(text: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`invalid price "${text}"`);
  const [, int = "0", frac = "", exp = "0"] = m;
  let digits = BigInt(int + frac);
  const shift = PRICE_SCALE_DECIMALS - frac.length + Number(exp);
  digits = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  return digits;
}

/**
 * Time-weighted average: each sample's price holds until the next sample, the
 * last one until `toMs`. Samples outside [fromMs, toMs] are ignored.
 */
export function computeTwap(samples: readonly PriceSample[], fromMs: number, toMs: number): bigint {
  const inWindow = samples
    .filter((s) => s.tsMs >= fromMs && s.tsMs <= toMs)
    .sort((a, b) => a.tsMs - b.tsMs);
  const first = inWindow[0];
  if (!first) throw new InsufficientSamplesError("no price samples in window");
  let weighted = 0n;
  let total = 0n;
  for (let i = 0; i < inWindow.length; i++) {
    const cur = inWindow[i]!;
    const end = inWindow[i + 1]?.tsMs ?? toMs;
    const dt = BigInt(end - cur.tsMs);
    weighted += cur.price * dt;
    total += dt;
  }
  if (total === 0n) return first.price; // single sample at the window end
  return weighted / total;
}

export interface TwapFetcherOptions {
  windowMs?: number;
  /** Required fraction of the window spanned by samples (first sample to window end). */
  minCoverage?: number;
  /**
   * Spacing of the samples in ms. History may start up to one interval later
   * than the coverage rule allows, so short windows still work: with a 60s
   * window and 30s samples the first sample may lie up to 30s after the window
   * start. Default 0 (strict coverage rule only).
   */
  sampleIntervalMs?: number;
  backoff?: BackoffOptions;
  now?: () => number;
}

export interface InitialPricesPayload {
  battleId: number;
  priceA: bigint;
  priceB: bigint;
}

export class TwapFetcher {
  private readonly windowMs: number;
  private readonly minCoverage: number;
  private readonly sampleIntervalMs: number;
  private readonly backoff: BackoffOptions;
  private readonly now: () => number;

  constructor(
    private readonly source: PriceSource,
    opts: TwapFetcherOptions = {},
  ) {
    this.windowMs = opts.windowMs ?? TWAP_WINDOW_MS;
    this.minCoverage = opts.minCoverage ?? 0.8;
    this.sampleIntervalMs = opts.sampleIntervalMs ?? 0;
    this.backoff = opts.backoff ?? { attempts: 5, baseDelayMs: 1_000, maxDelayMs: 30_000 };
    this.now = opts.now ?? Date.now;
  }

  /**
   * 30-minute TWAP for one token. Retries source failures and thin data with
   * exponential backoff; if all attempts fail it throws, so no price is ever
   * fabricated or written.
   */
  fetchTwap(token: string): Promise<bigint> {
    return withBackoff(async () => {
      const to = this.now();
      const from = to - this.windowMs;
      const samples = await this.source.samples(token, from, to);
      const inWindow = samples.filter((s) => s.tsMs >= from && s.tsMs <= to);
      const earliest = Math.min(...inWindow.map((s) => s.tsMs));
      // The first sample may start this late after the window start: the
      // uncovered share of the window, or one sample interval if that is longer.
      const allowedGap = Math.max(this.windowMs * (1 - this.minCoverage), this.sampleIntervalMs);
      if (inWindow.length === 0 || earliest - from > allowedGap) {
        throw new InsufficientSamplesError(`not enough price history for ${token}`);
      }
      const twap = computeTwap(inWindow, from, to);
      if (twap <= 0n || twap > U128_MAX) throw new Error(`TWAP out of range for ${token}`);
      return twap;
    }, this.backoff);
  }

  async initialPrices(battle: BattleView): Promise<InitialPricesPayload> {
    const [priceA, priceB] = await Promise.all([
      this.fetchTwap(battle.token_a),
      this.fetchTwap(battle.token_b),
    ]);
    return { battleId: battle.id, priceA, priceB };
  }

  /** Same 30-minute TWAP, used for the closing prices at settlement. */
  finalPrices(battle: BattleView): Promise<InitialPricesPayload> {
    return this.initialPrices(battle);
  }
}

/**
 * Re-reads the battle and, if it is still Approved and past its deposit
 * deadline, writes the initial TWAP prices. Price failures propagate before any
 * transaction is sent. Duplicate work items are no-ops.
 */
export async function lockWithInitialPrices(
  client: ArenaClient,
  fetcher: TwapFetcher,
  battleId: number,
  nowNs: bigint,
): Promise<"locked" | "skipped"> {
  const battle = await client.getBattle(battleId);
  if (!battle || battle.status !== "Approved") return "skipped";
  if (nowNs < BigInt(battle.deposit_deadline_ns)) return "skipped";
  const { priceA, priceB } = await fetcher.initialPrices(battle);
  await client.setInitialPrices(battleId, priceA, priceB);
  return "locked";
}

/**
 * DexScreener-backed price source. DexScreener only serves the current price,
 * so history is built by sampling: call `sampleOnce` periodically for every
 * token of Approved/Live battles (the token list is derivable from chain
 * state). `samples` returns what was recorded in the window; if the agent was
 * down and history is thin, TwapFetcher refuses to produce a price.
 */
export class DexScreenerPriceSource implements PriceSource {
  private readonly history = new Map<string, PriceSample[]>();

  constructor(
    private readonly dex: DexScreenerClient,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record the current price: the quote of the token's deepest pair. */
  async sampleOnce(token: string): Promise<PriceSample> {
    const pairs = (await this.dex.getPairs(token))
      .filter((p) => p.priceUsd !== null)
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
    const best = pairs[0];
    if (!best || best.priceUsd === null) throw new Error(`no priced pair for ${token}`);
    const price = parseUsdPrice(best.priceUsd);
    if (price <= 0n) throw new Error(`non-positive price for ${token}`);
    const sample = { tsMs: this.now(), price };
    const list = this.history.get(token) ?? [];
    list.push(sample);
    this.history.set(token, list);
    return sample;
  }

  async samples(token: string, fromMs: number, toMs: number): Promise<PriceSample[]> {
    // Drop samples older than the window; they can never be used again.
    const kept = (this.history.get(token) ?? []).filter((s) => s.tsMs >= fromMs);
    this.history.set(token, kept);
    const list = kept.filter((s) => s.tsMs <= toMs);
    return list;
  }
}
