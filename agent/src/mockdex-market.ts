import type { LiquiditySource } from "./auditor.js";
import type { NearTransport } from "./near-client.js";
import { PRICE_SCALE_DECIMALS, type PriceSample, type PriceSource } from "./twap.js";

/** USDC always has 6 decimals in the arena. */
export const USDC_DECIMALS = 6;

export interface DexRate {
  num: bigint;
  den: bigint;
}

interface RateView {
  num: string;
  den: string;
}

/**
 * Market data read from the mock DEX the arena executes on. The DEX owner can
 * change a rate at any time, which is how a testnet demo moves a price.
 *
 * Units: `get_rate { token_in, token_out }` gives `out = in * num / den` in base
 * units, `get_liquidity { token }` the DEX's holding of the token in base units.
 * All math is exact bigint math, rounded down.
 */
export class MockDexMarket implements LiquiditySource {
  private readonly decimals = new Map<string, number>();

  constructor(
    private readonly transport: Pick<NearTransport, "view">,
    readonly dex: string,
    readonly usdc: string,
  ) {}

  /** Raw rate, or null when the DEX has none (or an unusable one) for the pair. */
  async rate(tokenIn: string, tokenOut: string): Promise<DexRate | null> {
    const r = await this.transport.view<RateView | null>(this.dex, "get_rate", {
      token_in: tokenIn,
      token_out: tokenOut,
    });
    if (!r) return null;
    const num = BigInt(r.num);
    const den = BigInt(r.den);
    if (num <= 0n || den <= 0n) return null;
    return { num, den };
  }

  /** The DEX's holding of `token`, in the token's base units. */
  async rawLiquidity(token: string): Promise<bigint> {
    const v = await this.transport.view<string | number | null>(this.dex, "get_liquidity", { token });
    return v === null || v === undefined ? 0n : BigInt(v);
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
   * USD per whole coin scaled by 1e18, rounded down:
   * `10^dec * num / den` USDC base units per coin, i.e. `num * 10^(dec + 18 - 6) / den`.
   * Throws when there is no usable rate. A token valued below one unit of the
   * scale returns 0n, which callers must treat as unpriced.
   */
  async priceUsd(token: string): Promise<bigint> {
    if (token === this.usdc) return 10n ** BigInt(PRICE_SCALE_DECIMALS);
    const [rate, dec] = await Promise.all([this.rate(token, this.usdc), this.tokenDecimals(token)]);
    if (!rate) throw new Error(`no ${token} -> ${this.usdc} rate on ${this.dex}`);
    return priceFromRate(rate, dec);
  }

  /**
   * USD value of the DEX's holding of the token: base units valued at the
   * token's rate to USDC (floored to a USDC base unit), USDC at face value.
   * A token with no usable rate has no value, so it reports 0.
   */
  async liquidityUsd(token: string): Promise<number> {
    const amount = await this.rawLiquidity(token);
    if (amount === 0n) return 0;
    if (token === this.usdc) return usdcUnitsToUsd(amount);
    const rate = await this.rate(token, this.usdc);
    if (!rate) return 0;
    return usdcUnitsToUsd((amount * rate.num) / rate.den);
  }
}

/** Exact floor of the price implied by a base-unit rate; `num / den` USDC units per base unit. */
export function priceFromRate(rate: DexRate, tokenDecimals: number): bigint {
  const exp = tokenDecimals + PRICE_SCALE_DECIMALS - USDC_DECIMALS;
  return (rate.num * 10n ** BigInt(exp)) / rate.den;
}

function usdcUnitsToUsd(units: bigint): number {
  const whole = units / 10n ** BigInt(USDC_DECIMALS);
  const frac = units % 10n ** BigInt(USDC_DECIMALS);
  return Number(whole) + Number(frac) / 10 ** USDC_DECIMALS;
}

/**
 * Price source over the mock DEX. The DEX only serves the current rate, so
 * history is built by sampling (`sampleOnce` each pass), like the DexScreener
 * source.
 */
export class MockDexPriceSource implements PriceSource {
  private readonly history = new Map<string, PriceSample[]>();

  constructor(
    private readonly market: MockDexMarket,
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
