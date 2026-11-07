import { SEL_BALANCE_OF, isAddress, normalizeAddress, selector } from "../evm-abi.js";
import type { EvmRpc } from "../evm-rpc.js";
import { formatDecimal } from "./decimal.js";
import type { AuditAsset } from "./decision.js";
import type { LpEvidence, PoolEvidence } from "./liquidity.js";

/**
 * Independent LP evidence read on-chain through the Robinhood RPC.
 *
 * Valuation rule: only the reserve of an explicitly configured stablecoin is valued
 * (1 unit = 1 USD). The paired token side is not valued, so a pool is never credited more
 * than its stablecoin reserve. Pools whose other side is not a configured stablecoin are
 * ignored; no token is ever guessed to be a stablecoin.
 *
 * Verification status: exercised with fixtures only; no live testnet coverage is claimed.
 */

export interface PoolConfig {
  pool: string;
  /** `v2`: constant-product reserves via getReserves. `v3`: concentrated liquidity, balance only. */
  kind: "v2" | "v3";
}

export interface LpFetcherDeps {
  rpc: Pick<EvmRpc, "chainId" | "blockNumber" | "call">;
  /** Lowercase stablecoin address to token decimals; the explicit allow list. */
  stablecoins: ReadonlyMap<string, number>;
  pools: readonly PoolConfig[];
  now: () => Date;
}

const SEL_TOKEN0 = selector("token0()");
const SEL_TOKEN1 = selector("token1()");
const SEL_GET_RESERVES = selector("getReserves()");

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

export function createLpFetcher(deps: LpFetcherDeps): (asset: AuditAsset) => Promise<LpEvidence | null> {
  return async (asset) => {
    // Pools are read on the RPC's chain; refuse to read evidence for a different chain.
    if ((await deps.rpc.chainId()) !== BigInt(asset.chainId)) return null;
    const token = normalizeAddress(asset.token);
    const block = await deps.rpc.blockNumber();
    const observedAt = deps.now().toISOString();
    const pools: PoolEvidence[] = [];

    for (const cfg of deps.pools) {
      const pool = normalizeAddress(cfg.pool);
      const t0 = wordAddress(await deps.rpc.call({ to: pool, data: SEL_TOKEN0 }));
      const t1 = wordAddress(await deps.rpc.call({ to: pool, data: SEL_TOKEN1 }));
      if (t0 !== token && t1 !== token) continue;
      const stable = t0 === token ? t1 : t0;
      const decimals = deps.stablecoins.get(stable);
      if (decimals === undefined) continue; // quote asset is not on the explicit list

      let reserve: bigint;
      if (cfg.kind === "v2") {
        const r = await deps.rpc.call({ to: pool, data: SEL_GET_RESERVES });
        reserve = wordUint(r, t0 === token ? 1 : 0);
      } else {
        const data = SEL_BALANCE_OF + pool.slice(2).padStart(64, "0");
        reserve = wordUint(await deps.rpc.call({ to: stable, data }), 0);
      }
      pools.push({
        chainId: asset.chainId,
        poolId: pool,
        token,
        quoteAsset: stable,
        kind: cfg.kind === "v2" ? "constant_product" : "concentrated",
        headlineUsd: formatDecimal({ units: reserve, scale: decimals }),
        // Active-range executable depth is not computed for concentrated pools.
        executableDepthUsd: null,
        valuationSource: "configured-stablecoin-reserve",
        observedAt,
        observedBlock: block.toString(),
      });
    }
    return { chainId: asset.chainId, token, pools };
  };
}
