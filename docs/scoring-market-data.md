# Scoring market data for mainnet reference tokens

Research for issue [#68](https://github.com/mferdinandr/valtrum/issues/68), recorded 2026-11-08 between 13:18 and 13:29 UTC. Decision D9 says scoring data for a testnet mock token comes from its Robinhood mainnet (`4663`) reference token. This document records whether price, circulating supply, eligible 30-second volume and drawdown samples for the candidate reference tokens can be obtained reproducibly, with finality and provenance that fit the frozen 30-second observation policy (`docs/battle-rules.md`, `ObservationTerms` in `contracts/arena/src/rounds.rs`).

**Scope and labels.** Research only; no scoring code changed. All numbers below are **recorded public-service responses** from third-party aggregators, not on-chain verified values. The request list, timestamps, status codes and payload excerpts are in [`evidence/2026-11-08-scoring-market-data.json`](evidence/2026-11-08-scoring-market-data.json). The 13 tokens are the unverified candidates from the [findings log](findings-and-decisions.md#goplus-coverage-on-robinhood-mainnet-4663); their authenticity is still unchecked. Provider, cadence, tolerance and anti-manipulation choices are **owner decisions**; the options at the end are not adopted.

## Sources tried

| Source | Request | Result (2026-11-08) |
| --- | --- | --- |
| Robinhood docs `docs.robinhood.com/chain/connecting/` | HTTPS GET | **Failed.** The TLS certificate (Let's Encrypt R12) expired on 2026-08-19 08:35 UTC. Other hosts' certificates (e.g. `api.dexscreener.com`, valid to 2026-12-18) are valid, so the local clock is not the cause. |
| Public RPC `rpc.chain.robinhood.com` (assumed mainnet name), `rpc.testnet.chain.robinhood.com` (from `docs/`) | `eth_chainId`, `eth_getBlockByNumber` (`latest`, `safe`, `finalized`) | **Failed:** same expired certificate. TLS checks were not bypassed, because an unauthenticated response is not evidence. No chain ID, head, `safe` or `finalized` tag was observed. |
| Explorer `explorer.chain.robinhood.com` | `/api/v2/stats` | **Failed:** same expired certificate. |
| DexScreener `api.dexscreener.com/latest/dex/tokens/{address}` | 13 tokens | 200. Chain id `robinhood`. Spot price, liquidity, `marketCap`/`fdv` and rolling volume windows `m5`, `h1`, `h6`, `h24` only. At most 30 pairs per response. **WIF and RICO returned no pairs** (both had pools on 2026-11-07). |
| GeckoTerminal `api.geckoterminal.com/api/v2/networks/robinhood/...` | token, pools, `trades`, `ohlcv/minute` | 200 after pacing (the free tier returned 429 at roughly 2 s pacing; 7 s worked). `trades` returns the latest 300 trades with block number, second-resolution timestamp, tx hash, sender, amounts, USD price and `is_anomalous`. |
| GeckoTerminal `ohlcv/second?aggregate=15` | CASHCAT | **401:** `timeframe=second is exclusive to Paid plan subscribers only`. |
| CoinGecko `api.coingecko.com/api/v3/coins/{id}` | `cash-cat`, `rebate` | 200. Circulating supply exists only for tokens listed on CoinGecko (2 of 13); both report circulating equal to total supply. |

## Observations per token

From the responses above. "30 s windows with trades" counts distinct 30-second buckets that contain at least one trade within the span of the latest trades returned by GeckoTerminal. "Lag" is the age of the newest trade or 1-minute candle when it was fetched.

| Token | Top pool (DexScreener) | Liquidity USD | Latest trades: count / span | 30 s windows with trades | Newest trade lag | Circulating supply source |
| --- | --- | --- | --- | --- | --- | --- |
| CASHCAT | Uniswap v3 WETH (30 pairs, 21 over $10k, 10+ DEXes) | 1.74M | 300 / 1.85 h | 95 of ~222 (43%) | 11 min | CoinGecko 987,718,942.56 (= total) |
| BTCETHUSDT | Uniswap v3 | 38.0k | 93 / 21.2 h | 86 of ~2,540 | 20 min | none (GeckoTerminal `market_cap_usd` null) |
| REBATE | Uniswap v4 | 48.0k | 300 / 14.5 h | 147 of ~1,740 | 10 min | CoinGecko 980,960,963.13 (= total) |
| OAK | Uniswap v4 | 85.7k | 300 / 10.6 h | 209 of ~1,270 | 10 min | GeckoTerminal market cap only |
| STRATEGY | Uniswap v4 | 412k | 51 / 16.1 h | 23 | 7.9 h | GeckoTerminal market cap only |
| PENNY | Uniswap v4 | 132k | 2 / 7.5 h | 2 | 6.3 h | none |
| WIF | none | | no pairs | | | none |
| Rabbit | Uniswap v4 | 5.9k | 7 / 13.5 h | 7 | 10 min | none |
| ROBIN | Uniswap v3 | 5.2k | 12 / 19.0 h | 10 | 2.2 h | none |
| RICO | none | | no pairs | | | none |
| VLADIUS | Uniswap v3 | 3.7k | 12 / 20.4 h | 10 | 54 min | none |
| HODL | Uniswap v4 | 3.4k | 6 / 0.2 h | 3 | 12.6 h | none |
| CHAD | Uniswap v4 | 1.0k | 10 / 16.1 h | 10 | 7.5 h | none |

Chain timing, derived from GeckoTerminal trade block numbers and timestamps (CASHCAT, REBATE and OAK agree): about **0.107 s per block, about 280 blocks per 30-second round**. Block timestamps have **1-second resolution**, so roughly nine blocks share each timestamp. The chain's stack and finality rules could not be read from the Robinhood docs (expired certificate) and are **not verified**.

## Findings by input

**Price (all modes).** Spot pool prices exist for the 11 tokens that still have pools, but only as aggregator snapshots. DexScreener has no history or boundary selection. GeckoTerminal trades carry a per-trade USD price, but a round with no trade has no trade price, and a point price at `t0`/`t1` needs pool state at a chosen block. That needs an RPC with archive reads (`slot0`/`sqrtPriceX96` at the boundary block; Uniswap v4 state through its `PoolManager`). The two aggregators rank CASHCAT's top pool differently (DexScreener `0xA70f…E313`, GeckoTerminal `0xd42a…2b09`), so "the price" depends on a frozen pool choice. USD conversion adds a second price: WETH/USD or another quote token, frozen in the policy as well.

**Circulating supply (Market Cap % Growth, Volume-to-Market Cap Ratio).** Not reproducibly available. CoinGecko reports it for 2 of 13 tokens and sets it equal to total supply. DexScreener's `marketCap` equals `fdv` for 10 of the 11 tokens with pools (OAK is the exception, with no stated source). `docs/battle-rules.md` says a contract's total supply alone cannot stand in for circulating supply, so these two modes have **no compliant supply source** for any candidate today. A defined rule would have to be frozen first, e.g. total supply minus balances held by named burn or treasury addresses at the boundary block, read on-chain.

**Eligible 30-second volume (Volume-to-Market Cap Ratio).** DexScreener's shortest window is 5 minutes (rolling), which the rules explicitly reject. GeckoTerminal trades provide per-trade data with block numbers and tx hashes. However, they cover one pool per request and the latest 300 trades only, they arrive about 10 minutes late, and their timestamps are whole seconds, so the half-open `[t0, t1)` boundary cannot be placed between blocks that share a timestamp. Reproducible volume needs the `Swap` logs of every frozen eligible pool over the boundary block range, deduplicated by `(tx hash, log index)`. Most tokens trade in very few 30-second windows: outside CASHCAT, at most about 16% of windows have any trade (OAK), and 3% for BTCETHUSDT. A complete round with zero volume is valid, but **two zero-volume candidates tie**, and ties repeat without a cap.

**Drawdown samples (Lowest % Drawdown).** The only free history is 1-minute OHLCV, coarser than a 30-second round; second-level candles are paid-only (401). A compliant path needs a frozen sampling rule over pool state, e.g. one sample per block (~280) or per second (31 including both endpoints), read on-chain. Trade prices alone leave gaps in rounds without trades, and missing intermediate observations cannot be treated as flat.

**Finality and provenance.** No `finalized`/`safe` head and no reorg behaviour could be observed, because the RPC was unreachable over valid TLS. Aggregator data has no finality label, lags about 10 minutes for active tokens (hours for inactive ones), and is not reproducible later: `trades` returns only the latest 300, and DexScreener has no history at all. Aggregator responses can serve as a cross-check, not as the evidence an observation binds.

**Coverage.** Two candidates lost all pools within one day (WIF, RICO). The registry and policy must expect a reference token's market to disappear; scoring then stays Pending, as the spec already requires for missing evidence.

## What was not verified

- Chain ID `4663`, chain stack, block time from the chain itself, the `safe`/`finalized` tags, reorg depth and data-availability rules (RPC and docs unreachable).
- Token authenticity, totalSupply, and pool state on-chain; all values are aggregator-reported.
- Uniswap v4 pool reads (no RPC), the WETH/USD price path, and other quote tokens (MSTR, DJT, TTWO, WYFI, BOOMER).
- Paid GeckoTerminal second-level candles and any paid DexScreener product.
- Whether `is_anomalous` (GeckoTerminal) is useful as a manipulation signal; it was false for all 300 CASHCAT trades.

## Options for the owner (not decided)

Provider for the oracle's observation evidence:

1. **On-chain reads through an owner-provided archive RPC for `4663` (recommended).** Read pool state at the boundary blocks and per sample, `Swap` logs of the frozen pools for volume, and `totalSupply` plus frozen excluded balances for supply. This is reproducible, block-bound and deduplicable by `(tx hash, log index)`, and it can carry finality when the RPC exposes `finalized`. It needs a working RPC (the public endpoint currently has an expired certificate), Uniswap v4 `PoolManager` reads, and a USD quote path.
2. **Aggregator, paid tier (GeckoTerminal second-level OHLCV plus trades).** Fastest to build. But it is third-party and not reproducible later, it lags about 10 minutes, it has no finality, it ranks pools per its own model, and it has no circulating-supply source for most tokens.
3. **Hybrid:** option 1 as the bound evidence, plus an aggregator price as a deviation check that holds the round Pending above a frozen threshold.

Cadence and boundary (affects the drawdown and volume modes):

- Boundary by block: `t0`/`t1` map to the first block whose timestamp is at or after the boundary. This is deterministic, but with 1-second timestamps the tolerance cannot be below 1 s.
- Drawdown sampling: every block (~280 samples; most exact, more reads) or every second (31 samples; `max_gap_ns` = 1 s).
- Resolution delay: resolve only after the boundary blocks are finalized. The delay value depends on the unverified finality rule.

Anti-manipulation limits to consider:

- A frozen eligible-pool list per token with a minimum liquidity at lock (CASHCAT has 21 pools over $10k; others have one), excluding pools created after lock.
- For volume: count only frozen pools, deduplicate by `(tx hash, log index)`, and optionally exclude trades whose sender also trades the opposite side in the same round (a wash-trade heuristic).
- A minimum activity requirement for the volume and drawdown modes, or a tie-break rule, because illiquid pairs produce exact zero ties that repeat without a cap.

## Consequences

- No candidate has a compliant circulating-supply source, so Market Cap % Growth and Volume-to-Market Cap Ratio cannot be resolved for them today. Price % Gain and Lowest % Drawdown need on-chain pool reads.
- Aggregators alone cannot meet the frozen 30-second policy (boundary selection, finality, reproducibility).
- The OpenSpec task stays open: sources were researched, not verified against the chain.
