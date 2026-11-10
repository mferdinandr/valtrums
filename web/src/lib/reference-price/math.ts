/**
 * Display-only price math for the live preview. Floating point is fine here because nothing in this module settles
 * a battle; the contract scores only recorded oracle evidence.
 */

/**
 * The price of the non-WETH token in WETH from a Uniswap v3 `sqrtPriceX96`.
 * `p = (sqrtPriceX96 / 2^96)^2 * 10^(dec0 - dec1)` is the price of token0 in token1 units.
 * When token0 is WETH the token is token1, so its price in WETH is `1 / p`.
 */
export function tokenPriceInWeth(
  sqrtPriceX96: bigint,
  token0IsWeth: boolean,
  decimals0: number,
  decimals1: number,
): number | null {
  if (sqrtPriceX96 <= 0n) return null;
  if (!Number.isInteger(decimals0) || !Number.isInteger(decimals1)) return null;
  if (decimals0 < 0 || decimals1 < 0 || decimals0 > 36 || decimals1 > 36)
    return null;
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const price0In1 = ratio * ratio * 10 ** (decimals0 - decimals1);
  if (!Number.isFinite(price0In1) || price0In1 <= 0) return null;
  const price = token0IsWeth ? 1 / price0In1 : price0In1;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** Percent change from the first price, the unit the score chart plots. */
export function percentFrom(first: number, current: number): number | null {
  if (!Number.isFinite(first) || !Number.isFinite(current) || first <= 0)
    return null;
  return (current / first - 1) * 100;
}
