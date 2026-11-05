import type { HoneypotResult, HoneypotSimulator, LiquiditySource } from "./auditor.js";
import type { NearTransport } from "./near-client.js";
import type { QuoteSource } from "./quote.js";
import { PRICE_SCALE_DECIMALS, type PriceSample, type PriceSource } from "./twap.js";

/** USDC always has 6 decimals in the arena. */
const USDC_DECIMALS = 6;

interface PoolView {
  token_account_ids: string[];
  amounts: string[];
  total_fee: number;
}

/** Reserves of the pool that pairs a coin with USDC, in base units. */
export interface PoolReserves {
  poolId: number;
  usdc: bigint;
  coin: bigint;
  feeBps: number;
}

/**
 * Market data read from the exchange pools the swap adapter routes through.
 *
 * The adapter (`execution_dex`) knows which pool serves each pair
 * (`get_pool { token_in, token_out }`); the exchange gives the reserves
 * (`get_pool { pool_id }`) and exact quotes (`get_return`). Prices are the spot
 * ratio of the reserves, exact bigint math rounded down.
 */
export class RefMarket implements LiquiditySource {
  private readonly decimals = new Map<string, number>();

  constructor(
    private readonly transport: Pick<NearTransport, "view">,
    readonly exchange: string,
    readonly adapter: string,
    readonly usdc: string,
  ) {}

  /** Pool id the adapter uses for `tokenIn -> tokenOut`, or null when unrouted. */
  async poolId(tokenIn: string, tokenOut: string): Promise<number | null> {
    const id = await this.transport.view<number | null>(this.adapter, "get_pool", {
      token_in: tokenIn,
      token_out: tokenOut,
    });
    return id === null || id === undefined ? null : Number(id);
  }

  /** Reserves of the coin's USDC pool, or null when unrouted or not a USDC pair. */
  async reserves(token: string): Promise<PoolReserves | null> {
    const poolId = await this.poolId(this.usdc, token);
    if (poolId === null) return null;
    const pool = await this.transport.view<PoolView | null>(this.exchange, "get_pool", { pool_id: poolId });
    if (!pool || pool.token_account_ids.length !== 2 || pool.amounts.length !== 2) return null;
    const usdcIndex = pool.token_account_ids.indexOf(this.usdc);
    const coinIndex = pool.token_account_ids.indexOf(token);
    if (usdcIndex < 0 || coinIndex < 0 || usdcIndex === coinIndex) return null;
    return {
      poolId,
      usdc: BigInt(pool.amounts[usdcIndex] ?? "0"),
      coin: BigInt(pool.amounts[coinIndex] ?? "0"),
      feeBps: pool.total_fee,
    };
  }

  /** Token decimals from `ft_metadata`, read once per token. */
  async tokenDecimals(token: string): Promise<number> {
    if (token === this.usdc) return USDC_DECIMALS;
    const cached = this.decimals.get(token);
    if (cached !== undefined) return cached;
    const meta = await this.transport.view<{ decimals?: number }>(token, "ft_metadata", {});
    const d = meta?.decimals;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 38) {
      throw new Error(`invalid decimals in ft_metadata of ${token}`);
    }
    this.decimals.set(token, d);
    return d;
  }

  /**
   * USD per whole coin scaled by 1e18, rounded down. Throws when the coin has no
   * usable pool, so an unpriced coin is retried rather than treated as worthless.
   */
  async priceUsd(token: string): Promise<bigint> {
    if (token === this.usdc) return 10n ** BigInt(PRICE_SCALE_DECIMALS);
    const reserves = await this.reserves(token);
    if (!reserves || reserves.usdc <= 0n || reserves.coin <= 0n) {
      throw new Error(`no priced ${token} pool on ${this.exchange}`);
    }
    const dec = await this.tokenDecimals(token);
    return (reserves.usdc * 10n ** BigInt(dec + PRICE_SCALE_DECIMALS - USDC_DECIMALS)) / reserves.coin;
  }

  /**
   * Pool depth in whole USD: twice the USDC side, since a balanced pool holds
   * equal value on both sides. A coin with no pool has no liquidity.
   */
  async liquidityUsd(token: string): Promise<number> {
    if (token === this.usdc) return 0;
    const reserves = await this.reserves(token);
    if (!reserves) return 0;
    const units = reserves.usdc * 2n;
    const whole = units / 10n ** BigInt(USDC_DECIMALS);
    const frac = units % 10n ** BigInt(USDC_DECIMALS);
    return Number(whole) + Number(frac) / 10 ** USDC_DECIMALS;
  }
}

/** Price source over the pools. The pools only serve the current price, so history is sampled. */
export class RefPriceSource implements PriceSource {
  private readonly history = new Map<string, PriceSample[]>();

  constructor(
    private readonly market: Pick<RefMarket, "priceUsd">,
    private readonly now: () => number = Date.now,
  ) {}

  async sampleOnce(token: string): Promise<PriceSample> {
    const price = await this.market.priceUsd(token);
    if (price <= 0n) throw new Error(`non-positive price for ${token}`);
    const sample = { tsMs: this.now(), price };
    const list = this.history.get(token) ?? [];
    list.push(sample);
    this.history.set(token, list);
    return sample;
  }

  async samples(token: string, fromMs: number, toMs: number): Promise<PriceSample[]> {
    const kept = (this.history.get(token) ?? []).filter((s) => s.tsMs >= fromMs);
    this.history.set(token, kept);
    return kept.filter((s) => s.tsMs <= toMs);
  }
}

/**
 * Honeypot check against the pools: the coin needs a routed USDC pool with
 * reserves on both sides. This is a heuristic, not a simulated sale.
 */
export class RefHoneypotSimulator implements HoneypotSimulator {
  constructor(private readonly market: RefMarket) {}

  async check(token: string): Promise<HoneypotResult> {
    const reserves = await this.market.reserves(token);
    if (!reserves) return { honeypot: true, detail: `no routed USDC pool for ${token}` };
    if (reserves.usdc <= 0n || reserves.coin <= 0n) {
      return { honeypot: true, detail: `pool ${reserves.poolId} has an empty side` };
    }
    return { honeypot: false, detail: `pool ${reserves.poolId} holds both sides` };
  }
}

/** Exact swap quotes from the exchange (`get_return`, fee included). */
export class RefQuoteSource implements QuoteSource {
  constructor(
    private readonly transport: Pick<NearTransport, "view">,
    private readonly exchange: string,
  ) {}

  async expectedOut(dex: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<bigint> {
    const poolId = await this.transport.view<number | null>(dex, "get_pool", {
      token_in: tokenIn,
      token_out: tokenOut,
    });
    if (poolId === null || poolId === undefined) throw new Error(`no pool for ${tokenIn} -> ${tokenOut} on ${dex}`);
    const out = await this.transport.view<string | null>(this.exchange, "get_return", {
      pool_id: Number(poolId),
      token_in: tokenIn,
      amount_in: amountIn.toString(),
      token_out: tokenOut,
    });
    if (out === null || out === undefined) throw new Error(`no quote for ${tokenIn} -> ${tokenOut}`);
    return BigInt(out);
  }
}
