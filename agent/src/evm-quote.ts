import { decodeUintWord, encodeQuoteExactInputSingle } from "./evm-abi.js";
import type { EvmRpc } from "./evm-rpc.js";
import { minOutFromQuote } from "./quote.js";

/** Least acceptable output of a swap on the foreign chain. Throws when none can be determined. */
export interface EvmQuoteSource {
  minOut(p: { tokenIn: string; tokenOut: string; fee: number; amountIn: bigint }): Promise<bigint>;
}

/**
 * Reads `quoteExactInputSingle` from a Uniswap V3 QuoterV2 with `eth_call` and
 * applies a tolerance in basis points. A zero quote or a failing call throws, so
 * nothing is ever signed without a bound.
 */
export class UniswapV3QuoterSource implements EvmQuoteSource {
  constructor(
    private readonly rpc: Pick<EvmRpc, "call">,
    private readonly quoter: string,
    private readonly slippageBps: number,
  ) {
    minOutFromQuote(1n, slippageBps); // validates the tolerance at construction
  }

  async minOut(p: { tokenIn: string; tokenOut: string; fee: number; amountIn: bigint }): Promise<bigint> {
    const result = await this.rpc.call({ to: this.quoter, data: encodeQuoteExactInputSingle(p) });
    return minOutFromQuote(decodeUintWord(result, 0), this.slippageBps);
  }
}

/** Fixed answer, for tests. */
export class StaticEvmQuoteSource implements EvmQuoteSource {
  constructor(private readonly value: bigint | Error) {}
  async minOut(): Promise<bigint> {
    if (this.value instanceof Error) throw this.value;
    return this.value;
  }
}
