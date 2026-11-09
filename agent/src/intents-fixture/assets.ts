import { sha256Hex } from "../mcp/actions/canonical.js";

/**
 * FIXTURE: asset table of the local 1Click fixture (D29). Each row maps a NEAR Intents mainnet
 * asset id, copied from the recorded evidence (docs/evidence/2026-11-09-intents-routes.json), to a
 * testnet mock token. Mock ids and contract addresses are PLACEHOLDERS until the testnet mock
 * tokens exist (#72); see docs/intents-asset-mapping.md. Nothing here is a NEAR Intents asset.
 */

export interface FixtureAsset {
  symbol: string;
  decimals: number;
  /** 1Click `blockchain` value of the mainnet counterpart (`hood` is Robinhood Chain). */
  blockchain: "near" | "hood";
  /** The real mainnet 1Click asset id this mock stands in for. */
  mainnetAssetId: string;
  /** The id the fixture lists and accepts. */
  fixtureAssetId: string;
  /** EVM contract of the mock on Robinhood testnet (46630); absent for native ETH and NEAR assets. */
  contractAddress?: string;
  /** USD price shown in the listing (display only). */
  price: number;
  /** Recorded dry-quote output for 10 USDC (EXACT_INPUT, 1% slippage); absent when not recorded. */
  recordedQuote?: { amountOut: string; timeEstimate: number };
}

export const ORIGIN_USDC_MAINNET = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** Amount the recorded dry quotes were taken at: 10 USDC. */
export const RECORDED_QUOTE_AMOUNT_IN = 10_000_000n;

const placeholderAddress = (symbol: string): string => `0x${sha256Hex(`valtrum-fixture-mock:${symbol}`).slice(0, 40)}`;
const hood = (
  symbol: string,
  decimals: number,
  mainnetAssetId: string,
  price: number,
  native = false,
  recordedQuote?: FixtureAsset["recordedQuote"],
): FixtureAsset => ({
  symbol,
  decimals,
  blockchain: "hood",
  mainnetAssetId,
  fixtureAssetId: `nep141:mock-hood-${symbol.toLowerCase()}.fixture.testnet`,
  ...(native ? {} : { contractAddress: placeholderAddress(symbol) }),
  price,
  ...(recordedQuote ? { recordedQuote } : {}),
});

export const FIXTURE_ASSETS: readonly FixtureAsset[] = [
  {
    symbol: "USDC",
    decimals: 6,
    blockchain: "near",
    mainnetAssetId: ORIGIN_USDC_MAINNET,
    fixtureAssetId: "nep141:mock-usdc.fixture.testnet",
    price: 1,
  },
  hood("USDG", 6, "nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near", 1.0097, false, { amountOut: "9904355", timeEstimate: 19 }),
  hood("PONS", 18, "nep141:hood-0x39dbed3a2bd333467115de45665cc57f813c4571.omft.near", 0),
  hood("CASHCAT", 18, "nep141:hood-0x020bfc650a365f8bb26819deaabf3e21291018b4.omft.near", 0.0712, false, { amountOut: "140498434413074373040", timeEstimate: 21 }),
  hood("ETH", 18, "nep141:hood.omft.near", 2140, true, { amountOut: "4672722100085841", timeEstimate: 19 }),
  hood("WETH", 18, "nep141:hood-0x0bd7d308f8e1639fab988df18a8011f41eacad73.omft.near", 2140),
  hood("USDe", 18, "nep141:hood-0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34.omft.near", 1),
];

export const assetByFixtureId = (id: string): FixtureAsset | undefined => FIXTURE_ASSETS.find((a) => a.fixtureAssetId === id);
export const assetByMainnetId = (id: string): FixtureAsset | undefined => FIXTURE_ASSETS.find((a) => a.mainnetAssetId === id);
