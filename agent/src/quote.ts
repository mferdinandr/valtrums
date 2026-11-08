import type { NearTransport } from "./near-client.js";

/** Expected swap output for an exact input, in the output token's base units. */
export interface QuoteSource {
  /** Throws when no quote can be produced (view failed, no rate for the pair). */
  expectedOut(dex: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<bigint>;
}

export const BPS_DENOMINATOR = 10_000n;

/**
 * Least acceptable output: `quote * (10000 - slippageBps) / 10000`, rounded down
 * and never below 1. A zero quote has no valid minimum, so it is rejected.
 */
export function minOutFromQuote(quote: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error("slippage must be an integer number of basis points in [0, 9999]");
  }
  if (quote <= 0n) throw new Error("quote is zero, refusing to compute a minimum");
  const floored = (quote * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;
  return floored > 0n ? floored : 1n;
}

interface RateView {
  num: string;
  den: string;
}

/**
 * Reads the mock DEX's fixed rate (`get_rate`, out = in * num / den, floored).
 * FIXTURE: a demonstration quote, not a public-service price.
 */
export class MockDexQuoteSource implements QuoteSource {
  constructor(private readonly transport: Pick<NearTransport, "view">) {}

  async expectedOut(dex: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<bigint> {
    const rate = await this.transport.view<RateView | null>(dex, "get_rate", {
      token_in: tokenIn,
      token_out: tokenOut,
    });
    if (!rate) throw new Error(`no rate for ${tokenIn} -> ${tokenOut} on ${dex}`);
    const num = BigInt(rate.num);
    const den = BigInt(rate.den);
    if (den <= 0n) throw new Error(`invalid rate denominator for ${tokenIn} -> ${tokenOut}`);
    return (amountIn * num) / den;
  }
}
