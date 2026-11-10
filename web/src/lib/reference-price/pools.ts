/**
 * Reference pools for the live price preview. These are Uniswap v3 WETH-quoted pools on Robinhood Chain mainnet
 * (4663), the same pools the arena audit reads. The preview is display only: it is a reference price, not scoring
 * evidence, and a token without a v3 WETH pool (for example AI) has no entry and is shown as unavailable.
 */
export const WETH_ADDRESS = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const POOLS: Readonly<Record<string, string>> = {
  CASHCAT: "0xA70fc67C9F69da90B63a0e4C05D229954574E313",
  WALLET: "0x9501A20Bedb8beA0798FE5D4c411f5e270965D49",
  GOOD: "0x8EA7c66395fD7e25E9713Edd0B297d4ABE05C304",
  VLAD: "0x8a3aE9184141C085BAD6aBfEFcC626dE288be3d3",
  DEGEN: "0x5408AD4b4F1D5091B99953Af963500a792f47bc3",
};

/** The pool for a symbol, or null. Only a symbol in the fixed table above can ever select a pool. */
export function referencePool(symbol: string): string | null {
  return POOLS[symbol.toUpperCase()] ?? null;
}

export function referenceSymbols(): string[] {
  return Object.keys(POOLS);
}
