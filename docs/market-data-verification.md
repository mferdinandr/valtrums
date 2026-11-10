# Market-data source verification for the six demo reference tokens

Issue [#110](https://github.com/mferdinandr/valtrum/issues/110), recorded 2026-11-09 between 04:25Z and 04:41Z. It checks whether price, circulating supply, eligible volume, drawdown samples and finality can be obtained for each mainnet (`4663`) reference token against the frozen 30-second observation policy ([battle-rules.md](battle-rules.md), `ObservationTerms` in `contracts/arena/src/rounds.rs`). It follows the earlier research in [scoring-market-data.md](scoring-market-data.md) (13 candidates, aggregators only) and now covers the six tokens the owner chose in [reference-token-scan.md](reference-token-scan.md): CASHCAT, WALLET, GOOD, AI, VLAD and DEGEN.

**Labels.** Everything below is **recorded evidence** (live read-only requests on 2026-11-09). No sample is a fixture. Raw record: [evidence/2026-11-09-market-data-verification.json](evidence/2026-11-09-market-data-verification.json) (per token and per field: request, response excerpt, latency, limitations; plus the full request log). Nothing was registered, written or paid for; no secrets or RPC hosts are in the repo.

## What was and was not reachable

| Source | Request | Result |
| --- | --- | --- |
| Owner `REFERENCE_RPC_URL` (the Robinhood-hosted public RPC, host redacted) | `eth_chainId` (several attempts, 04:20Z to 04:37Z, no TLS bypass) | **Unreachable:** connection reset by peer, and a TLS handshake timeout after 20 s. The same host answered the 02:46Z to 03:48Z token scan, so this is intermittent or specific to this network. No other route to that host was tried. |
| PublicNode `robinhood-rpc.publicnode.com` (keyless, from the chainlist registry; **not** the owner RPC) | `eth_chainId`, heads, `eth_call`, `eth_getLogs` | Reachable, chain id `0x1237` (4663). Latest state only: any older block, `safe`, `finalized` or past log range is refused (below). Used so that on-chain facts could be recorded; it is a stand-in, not the owner's source. |
| DexScreener `token-pairs/v1/robinhood/{token}` | 6 tokens | 200 for all, 224 to 472 ms |
| GeckoTerminal `networks/robinhood` (token, pools, trades, `ohlcv/minute`) | 6 tokens | 200 after pacing; the free tier returned 429 several times (7 s pacing was not enough, 20 s worked) |
| GeckoTerminal `ohlcv/second?aggregate=15` | CASHCAT pool | **401**, paid plan only |
| GoPlus `token_security/4663` | 6 tokens | 200 for 5; DEGEN timed out once (30 s) and succeeded on retry; AI returned no `total_supply` and no holders |
| CoinGecko `onchain/networks/robinhood/tokens/{token}` | 6 tokens | **401**, an API key is required. `asset_platforms` does list `robinhood` (chain 4663). |

## Finality and timing (all tokens)

One sample from PublicNode at 2026-11-09 04:2xZ (see the evidence file for the exact heads):

| Item | Value | Against the 30 s round |
| --- | --- | --- |
| Block time (derived from head timestamps) | about 0.106 s, about 283 blocks per 30 s | consistent with 0.107 s from the 2026-11-08 research |
| `latest` read (`eth_call`, `slot0`) | median 348 to 377 ms per call, 31 sequential calls in 20.6 s (one outlier of 6.7 s), one batch of 31 calls in 477 ms | a single read fits the interval; unbatched per-second sampling does not reliably |
| `safe` head lag | 6,163 blocks, 653 s | about 22 rounds behind |
| `finalized` head lag | 10,047 blocks, 1,066 s (about 17.8 min) | about 36 rounds behind; resolving on a finalized boundary means a resolution delay of at least that |
| State at `safe` or `finalized` | `eth_call` returns "historical state ... is not available" | not readable on the free tier |
| State or logs at any older block (1, 280, 2,800, 8,200 blocks back) | HTTP 403 "Archive requests require a personal token" (one block back worked only for the two busiest pools) | boundary values for a past round cannot be read retrospectively |

The earlier record (2026-11-08) saw `finalized` trailing by about 8,200 blocks (about 14 minutes), so the lag varies; this is a single sample, not a distribution. Reorg behaviour and the data-availability rules were not observed.

## Evidence per token and field

"Verdict" is against the frozen policy: **OK** = a source supplies the field with the needed precision, **PARTIAL** = readable for the current block only or with the lag or coarseness stated, **GAP** = missing, too slow, or unable to supply it.

| Field | CASHCAT | WALLET | GOOD | AI | VLAD | DEGEN |
| --- | --- | --- | --- | --- | --- | --- |
| Price, on-chain top pool at latest (USD via D5 WETH/USDG, WETH about 2,140) | 0.07330 | 0.008618 | 0.0005255 | 0.0003708 | 0.0002335 | 0.0008365 |
| Price, DexScreener at fetch time | 0.07340 (-0.14%) | 0.008627 (-0.10%) | 0.0005257 (-0.04%) | 0.0004391 (**-15.5%**) | 0.0002338 (-0.12%) | 0.0008371 (-0.08%) |
| Price at a past boundary block | GAP | GAP | GAP | GAP | GAP | GAP |
| Circulating supply | GAP | GAP | GAP | GAP | GAP | GAP |
| Total supply (on-chain, whole tokens) | 1,000,000,000 | 1,000,000,000 | 999,999,992.5 | 1,000,000,000 | 1,000,000,000 | 1,195,302,942 |
| Balance at `0xdead` (share of total) | 12.33M (1.23%) | 54.81M (5.48%) | 0 | 0 | 50.36M (5.04%) | 0.875 tokens (0%) |
| Largest GoPlus holders | 12.1%, 4.9% (EOAs) | 8.1% (contract), 5.5% (dead) | 13.6%, 7.2% (contracts) | none returned | **70.0%** (contract), 11.2% | **88.2%** (contract), 9.7% |
| Eligible volume: DexScreener windows | m5 0, h1 2.1k, h24 722k | m5 288, h24 112k | m5 0, h24 32.7k | m5 9.0k, h24 695k | m5 0, h24 8.4k | m5 0, h24 15.4k |
| Eligible volume: GeckoTerminal trades (count / span / newest-trade lag) | 300 / 2.8 h / 442 s | 300 / 14.5 h / about 20 s | 300 / 22.1 h / 1,129 s | 300 / 0.26 h / 54 s | 50 / 23.5 h / 1,061 s | 157 / 23.2 h / 2,216 s |
| 30 s windows with a trade (within span) | 128 of 336 (38%) | 206 of 1,735 (12%) | 242 of 2,651 (9%) | 32 of 32 (100%) | 31 of 2,815 (1%) | 76 of 2,780 (3%) |
| Exact `[t0, t1)` volume (Swap logs) | GAP | GAP | GAP | GAP | GAP | GAP |
| 1-minute candles (GeckoTerminal), newest lag | 501 s | 518 s | 1,161 s | 102 s | 677 s | 2,243 s |
| 30 s or per-second samples | GAP | GAP | GAP | GAP | GAP | GAP |
| Uniswap v4 pools listed on DexScreener (liquidity not readable here) | 12 of 30 (USD 1.47M) | 7 of 10 (USD 73k) | 0 | 0 | 2 (USD 33) | 0 |

Per-field notes, each with the request and limitation in the evidence file:

- **Price.** `slot0()` on the highest-liquidity v3 pool returned a current point price in about 350 to 380 ms, within 0.15% of DexScreener for five tokens. The AI difference (-15.5%) is a stale aggregator snapshot of a token that traded USD 9k in five minutes (DexScreener 0.000439 and GeckoTerminal 0.000416 were fetched at different seconds and disagree with each other and with the chain), which is the point: aggregator prices are snapshots with no boundary selection. The price at a past boundary block could not be read for any token (no archive), so a gain or drawdown cannot be recomputed after the fact. USD needs a second price (WETH/USD from the D5 pool), and each token has several pools with different prices (for example GOOD and DEGEN secondary pools are priced in the token itself and are tiny).
- **Circulating supply.** Total supply is exact on-chain for all six (GOOD slightly burned, DEGEN 1.195B). No source states a circulating figure: GeckoTerminal `market_cap_usd` is null for WALLET, AI and VLAD, equals `fdv` for CASHCAT, differs slightly for GOOD and is 30 times `fdv` for DEGEN (USD 30.4M against 1.0M, internally inconsistent), DexScreener `marketCap` equals `fdv` for five of six, and CoinGecko needs a key. A possible rule (total minus the `0x0` and `0xdead` balances) removes only 1.2% to 5.5% and says nothing about contract holders: VLAD has 70% and DEGEN 88% of supply in a single contract (GoPlus holder list; not identified as a locker, vesting or treasury), so the figure would be far from the float. battle-rules.md forbids total supply as circulating supply, so the supply-dependent modes have no compliant input for any of the six.
- **Eligible volume.** DexScreener's shortest window is a rolling 5 minutes (rejected by the rules). GeckoTerminal trades carry block number, second-resolution timestamp, tx hash and USD volume per trade, but cover one pool per request, the latest 300 trades, and lag from about 20 s (WALLET, AI) up to 37 minutes (DEGEN). Only AI trades in every 30 s window of its span; CASHCAT 38%, WALLET 12%, GOOD 9%, DEGEN 3%, VLAD 1%, so for four tokens most rounds would have zero volume and tie at zero (ties repeat without a cap). `Swap` logs for a past range were refused on the free tier, so exact `[t0, t1)` volume is unavailable; only the latest block's logs could be requested.
- **Drawdown sampling.** The free history is 60 s candles with lag from 102 s to 2,243 s; second candles are paid-only. Per-block or per-second history needs archive state. Live forward sampling of the latest state is feasible (a batch of 31 calls returned in 477 ms) but was not run across a full round, reads unfinalized state, and cannot be audited later.
- **Finality.** See the table above: a 30 s round against a roughly 18 minute `finalized` head, with `safe` and `finalized` state unreadable on the free tier.

## Coverage by scoring mode

Needs per mode: Price % Gain needs price at `t0` and `t1`; Market Cap % Growth needs price and circulating supply at both; Volume-to-Market Cap Ratio needs exact `[t0, t1)` volume and `M(t0)` (price and supply at `t0`); Lowest % Drawdown needs price samples across the round at a frozen cadence.

| Mode | Blocking gaps (same for all six unless noted) | Reproducible and finalized today | Demonstrable live (not reproducible) |
| --- | --- | --- | --- |
| Price % Gain | boundary-block price (no archive); finality about 18 min | None | Yes for all six, by reading `slot0` at the start and end of a live round; unfinalized, and `AI` and `CASHCAT` have the most pool-choice ambiguity (several pools and, for CASHCAT, 12 v4 pools) |
| Market Cap % Growth | all of the above plus no circulating-supply rule or source | None | No: needs a frozen supply rule; contract holders of 70% (VLAD) and 88% (DEGEN) make any total-minus-burned figure doubtful |
| Volume-to-Market Cap Ratio | exact volume (logs refused), `M(t0)` (supply), 5-minute and lagged aggregator volume | None | No for the same supply reason; volume alone is likely only for AI (and partly CASHCAT); the others tie at zero in most rounds |
| Lowest % Drawdown | per-block or per-second history (no archive); candles are 60 s | None | Partly: forward polling at latest works for all six; for VLAD, DEGEN, GOOD and WALLET most rounds are flat, so many tie at 0% drawdown |

## Gaps recorded

1. **Owner RPC unreachable (all fields).** `REFERENCE_RPC_URL` was reset or timed out; nothing could be verified against the owner's source. Affects every mode.
2. **No archive state or log history on the free RPC (price, volume, drawdown).** Affects every mode; boundary-bound values for a past round cannot be re-read.
3. **No circulating-supply source or rule (supply).** Affects Market Cap % Growth and Volume-to-Market Cap Ratio for all six; VLAD and DEGEN additionally hold 70% and 88% in one contract each.
4. **Finality about 18 minutes behind `latest`, `safe` and `finalized` state unreadable (finality).** A 30 s round cannot be resolved on finalized data without a long resolution delay and a state-serving RPC. Affects every mode.
5. **Aggregator volume and history are too coarse or too slow (volume, drawdown).** 5 minute volume windows, 60 s candles, 20 s to 37 minute trade lag, 300-trade cap, paid-only second candles.
6. **Thin activity.** Four of the six tokens have trades in 12% or fewer 30 s windows; zero-volume and zero-drawdown ties repeat without a cap (Volume-to-Market Cap Ratio and Lowest % Drawdown).
7. **GoPlus gaps for AI.** `total_supply` and holders were absent, and GoPlus timed out once for DEGEN; these affect audit freshness and the holder-based supply checks.
8. **Uniswap v4 liquidity (price pool choice).** CASHCAT has 12 v4 pairs (USD 1.47M listed) and WALLET 7 (USD 73k) that were not probed; a frozen eligible-pool list must say whether they count.

## Not verified

The owner RPC at any depth; an archive RPC with a personal token; Uniswap v4 reads; a live forward sampling run across a full round; identity of the large contract holders of VLAD and DEGEN; second-level paid products; CoinGecko with an API key; any reorg behaviour. Single-sample latencies and lags, taken from one network location, can differ at the demo.

## Deviations / assumptions

- **The owner RPC could not be used, so a public RPC stood in.** PublicNode (keyless, read-only, from the chainlist registry, as in the 2026-11-08 arena-audit record) supplied the on-chain facts. It is labeled in the record and is not the owner's source; the owner should confirm whether the owner RPC outage is temporary, then re-run the on-chain section (`eth_call` and `eth_getLogs` at boundary blocks) against it.
- **Pool choice is an assumption.** The highest-liquidity v2/v3 pool by DexScreener was probed for price and log reads; no eligible-pool list was frozen.
- **USD price path is an assumption.** WETH/USD from the D5 pool (WETH/USDG) was used for conversion.
- **Provider is not chosen.** Options and trade-offs for the owner to decide:
  1. **Archive RPC for `4663` (owner-provided, or a provider personal token).** Reproducible, block-bound, deduplicable by `(tx hash, log index)`, can carry `safe` or `finalized`. Needs a working endpoint, a state-serving tier (PublicNode returns 403 beyond the latest block), a v4 reader and a supply rule. Highest build cost and the only path that can supply exact `[t0, t1)` volume.
  2. **Aggregator, paid tier.** Fastest to build; second-level candles exist only on paid plans. Third-party, not reproducible later, 20 s to 37 minutes of lag, no finality label, a 300-trade cap, no circulating supply.
  3. **Live forward sampling on a latest-state RPC.** Works today for price and drawdown (and perhaps volume from block logs as they arrive); cheap. Unfinalized, not auditable afterward and depends on the sampler staying up for the whole round.
  4. **Hybrid:** option 1 (or 3) as the bound evidence and an aggregator as a deviation check that holds the round Pending above a threshold.
- **Cadence and boundary** (affects drawdown and volume): per-block sampling (about 283 samples) versus per-second (31 samples, `max_gap_ns` of 1 s); boundary by first block at or after the timestamp (1-second timestamps put about nine blocks on each second, so tolerance cannot be below 1 s); resolution delay value depends on the finality rule (about 18 minutes if `finalized`).
- **Supply rule** (affects two modes): either freeze a documented rule (total minus named excluded balances at the boundary block, which needs the owner to name the VLAD and DEGEN contract holders) or restrict those two modes to tokens with an independent circulating-supply source.
- **Activity floor** (affects ties): consider a minimum-activity requirement or a tie rule for the volume and drawdown modes; four of six tokens would tie at zero in most rounds.
- **Not decided here:** which provider, the cadence, the tolerance, the supply definition, and the finality tag. These stay with the owner.

## Consequences

- With the sources checked today, no mode can be resolved reproducibly on finalized data for any of the six tokens.
- A live demo of Price % Gain and Lowest % Drawdown is possible for all six from latest-state reads; Market Cap % Growth and Volume-to-Market Cap Ratio need a supply rule first; volume is only meaningful for AI and CASHCAT.
- The OpenSpec task stays open for the on-chain verification against the owner RPC (see [the change tasks](openspec/changes/arena-testnet-integrations/tasks.md)).
