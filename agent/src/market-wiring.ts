import { DexHeuristicHoneypotSimulator, DexLiquiditySource, type HoneypotSimulator, type LiquiditySource } from "./auditor.js";
import type { ArenaClient } from "./client.js";
import { DexScreenerClient } from "./dexscreener.js";
import { createFetchHttpClient } from "./http.js";
import type { MarketConfig } from "./market-config.js";
import { MockDexHoneypotSimulator } from "./mockdex-honeypot.js";
import { MockDexMarket, MockDexPriceSource } from "./mockdex-market.js";
import type { NearTransport } from "./near-client.js";
import type { PriceSampler } from "./runtime.js";
import { DexScreenerPriceSource, type PriceSource } from "./twap.js";

export interface MarketSources {
  priceSource: PriceSource;
  sampler: PriceSampler;
  liquidity: LiquiditySource;
  honeypot: HoneypotSimulator;
}

/** Build the price, liquidity and honeypot sources for the configured market data. */
export async function createMarketData(
  cfg: MarketConfig,
  client: ArenaClient,
  transport: Pick<NearTransport, "view">,
  dexscreenerApiKey: string | undefined,
): Promise<MarketSources> {
  if (cfg.marketData === "mockdex") {
    const { execution_dex, usdc } = await client.getConfig();
    if (!execution_dex) {
      throw new Error("MARKET_DATA=mockdex needs get_config().execution_dex, but the arena has none set");
    }
    if (!usdc) throw new Error("MARKET_DATA=mockdex needs get_config().usdc, but it is empty");
    const market = new MockDexMarket(transport, execution_dex, usdc);
    const source = new MockDexPriceSource(market);
    return {
      priceSource: source,
      sampler: source,
      liquidity: market,
      honeypot: new MockDexHoneypotSimulator(market),
    };
  }
  const dex = new DexScreenerClient({ http: createFetchHttpClient(), apiKey: dexscreenerApiKey });
  const source = new DexScreenerPriceSource(dex);
  return {
    priceSource: source,
    sampler: source,
    liquidity: new DexLiquiditySource(dex),
    honeypot: new DexHeuristicHoneypotSimulator(dex),
  };
}
