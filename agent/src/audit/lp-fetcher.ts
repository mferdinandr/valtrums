import { SEL_BALANCE_OF, isAddress, normalizeAddress, selector } from "../evm-abi.js";
import type { ReadOnlyEvmRpc } from "../rpc-resilience.js";
import { compareDecimal, formatDecimal, parseDecimal } from "./decimal.js";
import { goplusTarget, type AuditAsset } from "./decision.js";
import { VALUATION_SOURCE, type LpEvidence, type PoolEvidence, type UnpricedCode } from "./liquidity.js";

/**
 * Independent LP evidence read on-chain for the REFERENCE token (Robinhood mainnet 4663) when the
 * asset is mapped, never from the testnet mock's pools; testnet pools do not represent the real
 * market. An unmapped asset is read on its own chain. The RPC must serve that chain.
 *
 * Valuation (`headline_quote_balance`): a pool's value is the balance of its QUOTE side only, read
 * at one block (v2 reserve, v3 `balanceOf(pool)` of the quote token). The audited token's own side
 * is never valued and the quote side is not doubled. A quote asset must be an explicitly
 * configured stablecoin (1 unit = 1 USD) or the configured WETH. WETH is priced from the `slot0`
 * price of ONE configured WETH/stablecoin Uniswap v3 pool read in the same block, subject to a
 * configured floor on that pool's stable-side balance. Token decimals are read on-chain. Nothing is
 * defaulted or guessed: unset pool, floor or lists leave the result Pending.
 *
 * This is an approximation, not executable depth: v3 balances can include out-of-range liquidity
 * and can be moved briefly. Fixture-verified only; no live coverage is claimed.
 */

export interface PoolConfig {
  pool: string;
  /** `v2`: constant-product reserves via getReserves. `v3`: concentrated liquidity, quote balance via balanceOf. */
  kind: "v2" | "v3";
}

export interface WethConfig {
  /** Explicit WETH address on the audited chain (never guessed). */
  address: string;
  /** Chain the price pool and WETH live on (for example 4663); a mismatch with the audited chain leaves WETH unpriced. */
  chainId: string;
  /** The one WETH/stablecoin Uniswap v3 pool that prices WETH. Unset: WETH-quoted pools stay unpriced. */
  pricePool?: string;
  /** Floor for the stable-side balance of the price pool, in USD (decimal text). Unset or unmet: Pending. */
  pricePoolMinUsd?: string;
}

export interface LpFetcherDeps {
  /** Read-only mainnet RPC (REFERENCE_RPC_URL), wrapped with the shared retry policy by the caller. */
  rpc: ReadOnlyEvmRpc;
  /** Lowercase stablecoin address to expected decimals; the explicit allow list (verified on-chain). */
  stablecoins: ReadonlyMap<string, number>;
  pools: readonly PoolConfig[];
  weth?: WethConfig;
}

const SEL_TOKEN0 = selector("token0()");
const SEL_TOKEN1 = selector("token1()");
const SEL_GET_RESERVES = selector("getReserves()");
const SEL_SLOT0 = selector("slot0()");
const SEL_DECIMALS = selector("decimals()");
const Q192 = 1n << 192n;

function word(hex: string, index: number): string {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  const w = body.slice(index * 64, index * 64 + 64);
  if (w.length !== 64 || !/^[0-9a-fA-F]+$/.test(w)) throw new Error("malformed EVM call result");
  return w;
}

const wordAddress = (hex: string, index = 0): string => `0x${word(hex, index).slice(24)}`;
const wordUint = (hex: string, index: number): bigint => BigInt(`0x${word(hex, index)}`);

export function validateStablecoins(map: Record<string, unknown>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [addr, decimals] of Object.entries(map)) {
    if (!isAddress(addr) || typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new Error("stablecoin list entries must map a 20-byte address to integer decimals 0-36");
    }
    out.set(normalizeAddress(addr), decimals);
  }
  return out;
}

type Price =
  | {
      ok: true;
      pricePool: string;
      sqrtPriceX96: bigint;
      wethIsToken0: boolean;
      stableDecimals: number;
      stableBalanceRaw: bigint;
    }
  | { ok: false; code: UnpricedCode };

/** USD value (in stablecoin raw units, rounded down) of `wethRaw` WETH at a v3 slot0 price. */
export function wethToStableRaw(wethRaw: bigint, sqrtPriceX96: bigint, wethIsToken0: boolean): bigint {
  const p = sqrtPriceX96 * sqrtPriceX96; // price(token1 per token0) * 2^192, in raw units
  // Decimals cancel: both the price and the result are in raw token units.
  return wethIsToken0 ? (wethRaw * p) / Q192 : (wethRaw * Q192) / p;
}

export function createLpFetcher(deps: LpFetcherDeps): (asset: AuditAsset) => Promise<LpEvidence | null> {
  return async (asset) => {
    // The evidence subject is the reference token when mapped, else the asset itself.
    const target = goplusTarget(asset);
    // Refuse to read evidence for a chain the RPC does not serve.
    if ((await deps.rpc.chainId()) !== BigInt(target.chainId)) return null;
    const token = normalizeAddress(target.token);
    // Every read below is pinned to this block, and its own timestamp is the observation time.
    const block = await deps.rpc.blockNumber();
    const observedAt = new Date(Number(await deps.rpc.blockTimestamp(block)) * 1000).toISOString();
    const read = (to: string, data: string) => deps.rpc.call({ to, data }, block);
    const balanceOf = async (tokenAddr: string, holder: string) =>
      wordUint(await read(tokenAddr, SEL_BALANCE_OF + holder.slice(2).padStart(64, "0")), 0);
    const weth = deps.weth ? normalizeAddress(deps.weth.address) : null;

    // Decimals are read on-chain; a configured value that disagrees fails the read (fail closed).
    const decimalsMemo = new Map<string, number>();
    const decimalsOf = async (stable: string): Promise<number> => {
      const known = decimalsMemo.get(stable);
      if (known !== undefined) return known;
      const configured = deps.stablecoins.get(stable);
      const onChain = Number(wordUint(await read(stable, SEL_DECIMALS), 0));
      if (configured === undefined || onChain !== configured) {
        throw new Error(`stablecoin ${stable} decimals do not match the configured list`);
      }
      decimalsMemo.set(stable, onChain);
      return onChain;
    };

    let priceMemo: Price | undefined;
    const wethPrice = async (): Promise<Price> => {
      if (priceMemo) return priceMemo;
      const cfg = deps.weth;
      if (!cfg?.pricePool) return (priceMemo = { ok: false, code: "quote_asset_unpriced" });
      const floor = cfg.pricePoolMinUsd ? parseDecimal(cfg.pricePoolMinUsd) : null;
      if (!floor) return (priceMemo = { ok: false, code: "price_pool_floor_unset" });
      // The price pool must be on the audited chain and made of the configured WETH and a listed stablecoin.
      if (cfg.chainId !== target.chainId) return (priceMemo = { ok: false, code: "price_pool_invalid" });
      const pool = normalizeAddress(cfg.pricePool);
      const t0 = wordAddress(await read(pool, SEL_TOKEN0));
      const t1 = wordAddress(await read(pool, SEL_TOKEN1));
      const stable = t0 === weth ? t1 : t1 === weth ? t0 : null;
      if (!stable || !deps.stablecoins.has(stable)) return (priceMemo = { ok: false, code: "price_pool_invalid" });
      const stableDecimals = await decimalsOf(stable);
      const sqrtPriceX96 = wordUint(await read(pool, SEL_SLOT0), 0);
      if (sqrtPriceX96 === 0n) return (priceMemo = { ok: false, code: "price_pool_invalid" });
      const stableBalanceRaw = await balanceOf(stable, pool);
      const stableUsd = parseDecimal(formatDecimal({ units: stableBalanceRaw, scale: stableDecimals }));
      if (!stableUsd || compareDecimal(stableUsd, floor) < 0) {
        return (priceMemo = { ok: false, code: "price_pool_floor_not_met" });
      }
      return (priceMemo = {
        ok: true,
        pricePool: pool,
        sqrtPriceX96,
        wethIsToken0: t0 === weth,
        stableDecimals,
        stableBalanceRaw,
      });
    };

    const pools: PoolEvidence[] = [];
    for (const cfg of deps.pools) {
      const pool = normalizeAddress(cfg.pool);
      const t0 = wordAddress(await read(pool, SEL_TOKEN0));
      const t1 = wordAddress(await read(pool, SEL_TOKEN1));
      if (t0 !== token && t1 !== token) continue;
      const quote = t0 === token ? t1 : t0;
      const isStable = deps.stablecoins.has(quote);
      const isWeth = weth !== null && quote === weth;
      if (!isStable && !isWeth) continue; // quote asset not on an explicit list

      // Quote-side balance only; the audited token's side is never read for value.
      const quoteRaw =
        cfg.kind === "v2"
          ? wordUint(await read(pool, SEL_GET_RESERVES), t0 === token ? 1 : 0)
          : await balanceOf(quote, pool);
      const base = {
        chainId: target.chainId,
        poolId: pool,
        token,
        quoteAsset: quote,
        kind: cfg.kind === "v2" ? ("constant_product" as const) : ("concentrated" as const),
        valuationSource: VALUATION_SOURCE,
        observedAt,
        observedBlock: block.toString(),
      };
      if (isStable) {
        pools.push({ ...base, headlineUsd: formatDecimal({ units: quoteRaw, scale: await decimalsOf(quote) }) });
        continue;
      }
      const price = await wethPrice();
      if (!price.ok) {
        pools.push({ ...base, headlineUsd: null, unpriced: price.code });
        continue;
      }
      const usdRaw = wethToStableRaw(quoteRaw, price.sqrtPriceX96, price.wethIsToken0);
      pools.push({
        ...base,
        headlineUsd: formatDecimal({ units: usdRaw, scale: price.stableDecimals }),
        quotePricing: {
          pricePool: price.pricePool,
          sqrtPriceX96: price.sqrtPriceX96.toString(),
          wethIsToken0: price.wethIsToken0,
          stableBalanceUsd: formatDecimal({ units: price.stableBalanceRaw, scale: price.stableDecimals }),
          block: block.toString(),
        },
      });
    }
    return { chainId: target.chainId, token, pools };
  };
}
