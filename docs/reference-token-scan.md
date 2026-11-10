# Reference-token scan (Robinhood mainnet 4663, 2026-11-09)

Purpose: find memecoins that pass audit policy v1 today, as candidate reference tokens for the demo registry (D21). Read-only. Nothing was registered and no funds moved. Raw record: [evidence/2026-11-09-reference-token-scan.json](evidence/2026-11-09-reference-token-scan.json).

## Method

- The agent's own audit code path ran unmodified from the compiled `agent/` sources: `fetchGoPlusTokenSecurity` (no credential), `createLpFetcher` (USDG as the only listed stablecoin, WETH priced by the D5 pool with its USD 1,000,000 floor) and `evaluateCommunity` with `audit-policy-v1` (TTL 600 s). Nothing was loosened or invented.
- RPC `https://rpc.mainnet.chain.robinhood.com`, honest User-Agent, reads pinned to the current block (blocks 109,731,155 to 109,753,339, 02:46Z to 03:48Z). It is not an archive node. GoPlus returned code 4029 after about 100 requests in a few minutes; requests were then paced (one at a time, 5 s apart) and a 4 minute cool-down was respected.
- Pool kind (v2 or v3) was decided by an on-chain probe, not by DexScreener labels. Uniswap v4 pools (32-byte ids) and native-ETH quotes cannot be read by the fetcher (D32) and are reported separately.
- Discovery: 89 DexScreener searches (chain id `robinhood`) gave 224 tokens and 377 pairs; with the 13 earlier candidates that is 229 unique tokens. The 1Click list for `hood` has only six assets (USDG, PONS, CASHCAT, ETH, WETH, USDe); PONS was the only one not among the 13. 181 tokens were queried on GoPlus and 179 returned data (the 2026-11-07 figure of 13 in about 250 is out of date). 127 were run through the audit: every token with GoPlus data, DexScreener liquidity of at least USD 3,000 and not a tokenized stock. Tokenized stocks and thin tokens were not audited (the 52 are listed in the evidence file).

## Result today

**11 tokens pass audit policy v1** (24 reject, 92 pending). All 11 pass on GoPlus data and a headline LP value strictly above USD 10,000.

| Token | Address | GoPlus | Liquidity counted (headline quote balance) | Pool type | Authenticity | Blockers and flags |
| --- | --- | --- | --- | --- | --- | --- |
| CASHCAT | `0x020bfC650A365f8BB26819deAAbF3E21291018b4` | clean, tax 0, owner empty | USD 990,012 (15 pools) | v3 (WETH, USDG), v2 (USDG) | On 1Click (CoinGecko id), Sourcify match, 18 decimals, supply 1B | None found; most robust candidate. v4 and native-ETH pools worth about USD 1.5M are not counted |
| WALLET | `0x0339f5459fC690ac85f1782E15782A151b4a9e1b` | clean, tax 0, owner empty | USD 477,858 (2 pools) | v3 (WETH) | Name "Robinhood Wallet", Sourcify match, not on 1Click | Brand-impersonation look: it is a launchpad memecoin named after a real product, and another `WALLET` exists at `0x72548C88...`. Not a memecoin by theme |
| HOODRAT | `0x8e62f281F282686fCA6dCB39288069a93Fc23f1C` | clean; `is_whitelisted` active, owner is the zero address | USD 97,238 (3 pools) | v2 and v3 (WETH, USDG) | Source not verified on Sourcify, not on 1Click | Active whitelist capability is admissible only because ownership is renounced; a second `HOODRAT` exists |
| GOOD | `0x5F62c57E5C537887117eEF828b7e3aD41C009FEb` | clean, tax 0, owner empty | USD 65,137 (1 pool) | v3 (WETH) | Sourcify exact match, not on 1Click | Supply 999,999,992.5M (slightly burned). A further USD 10k of pools with unlisted quotes is ignored |
| moon | `0x862cdccb67C8a22FDB247d09A08B1dad09447777` | tax 5 percent buy and sell (at the cap), owner zero | USD 37,654 (1 pool) | v2 (WETH) | EIP-1167 minimal proxy (45 bytes) to `0x7777c874...3333`; the implementation is Sourcify verified, the proxy is not | GoPlus reports `is_proxy` 0 although the token is a clone; a 5 percent tax each way distorts price scoring |
| AI (Affair Inu) | `0x0d4a117DCcCe7ba3D0a475ec9068c20C35310Fd8` | clean, tax 0, owner empty | USD 32,081 (1 pool) | v3 (WETH) | Sourcify match, not on 1Click | Ticker `AI` is shared by at least two other tokens (`0x2E8c3116...`, `0x1e0AAaf3...`); single pool, one LP holder |
| VLAD (The Robinhood) | `0xFDbB27E971E72E38C41b1c772FB409c94dd92789` | clean, tax 0, owner empty | USD 23,210 (1 pool) | v3 (WETH) | Sourcify match, not on 1Click | Four other `VLAD` tokens exist; one LP holder |
| SANTACOIN (SANTAHOOD) | `0x38bb87cf3e7344A82bE7cD671c191f015b97eeE6` | clean, tax 0, owner empty | USD 21,016 (2 pools) | v3 (WETH), v2 (USDG) | Source not verified, not on 1Click | Same code size (4,830 bytes) as CASHCAT, different bytecode hash; one LP holder |
| BTCETHUSDT | `0xAE2Df3c1749daEE721c1BFCBbfdde5D61ae7cb99` | clean, tax 0, owner empty | USD 17,179 (1 pool) | v3 (WETH) | Sourcify exact match, not on 1Click | Token name is a 7,000-character string of ticker names (joke or search spam); the USD 10,000 margin is thin |
| WIF (RobinWifHat) | `0xe49a1c3033eCc6B804bC423021d3f71f1a3E0F9b` | clean, tax 0, owner `0x...dEaD` | USD 16,639 (1 pool) | v3 (WETH) | Source not verified, not on 1Click | Not the other `WIF` (`0x5173b8eA...`, World is Flat); owner is the dead address, no active capability |
| DEGEN | `0x0830a9dD26A04E959657aB6788d45F5725590c32` | clean, tax 0; owner is `0x2448e648...` (not renounced) but every admin capability is off | USD 15,850 (1 pool) | v3 (WETH) | Sourcify exact match, not on 1Click | Supply 1.195B (not the usual 1B) with a live owner: confirm no mint path; another USD 34k of pools with unlisted quotes is ignored |

All 11 have 18 decimals, code present, are not EIP-1967 proxies and were queried on GoPlus once; the headline value is the quote-side balance only and can include out-of-range v3 liquidity (D4, D32). Look-alike counts come from DexScreener searches by symbol and are lower bounds. The official explorer (`explorer.chain.robinhood.com`) failed the TLS handshake and was not retried; the only independent address source for any of them is 1Click (CASHCAT, PONS) and Sourcify (see column).

## The 13 earlier candidates, actual decisions

| Token | Decision | Reasons |
| --- | --- | --- |
| CASHCAT, BTCETHUSDT | pass | see above |
| STRATEGY (`0x1686...`) | reject | `admin_privilege_not_renounced` (`transfer_pausable`), LP USD 1,037 readable (USD 414k sits in v4) |
| PENNY (`0x4124...`) | pending | `is_honeypot`, `cannot_sell_all`, admin flags unknown; no readable pool (USD 186k in v4) |
| REBATE, OAK (`0x6511...`), Rabbit, RICO | pending | `cannot_sell_all` unknown; no or thin readable LP |
| WIF (`0x96c5...`), HODL, CHAD | pending | `cannot_sell_all` and all three tax fields unknown; no pools listed |
| ROBIN (`0x4c92...`), VLADIUS | pending | GoPlus clean; LP USD 1,040 and USD 308 (at or below USD 10,000) |

## Not passing, but worth knowing

- **GoPlus clean, liquidity unreadable:** one token, BULL `0x49bac47750f3dcdba49350b5d74fd399e90f97c6` (liquidity USD 52,464 on DexScreener, all in native-ETH v4 pools; readable LP USD 338). Supporting v4 and native-ETH quotes would add at most this one token. The other 10 passing tokens already pass on v2 and v3 alone.
- **Blocked only by a missing `cannot_sell_all`:** PONS (1Click listed, readable LP USD 1.25M), RAM (USD 135k), GOO (USD 89k readable, USD 390k more in unlisted quotes), ORBIO (USD 68k), microduck (USD 29k), BOW (USD 20k). GoPlus omits the field for them, so policy v1 holds Pending. FOBO has USD 5.6M in native-ETH v4 and would also need that field.
- **Thin:** ROBINHOOD `0x79fe...` (USD 5.5k), PEPE `0xcdca...` (USD 6.3k), HODL `0xf4c4...`, SC, ROCKET, GME `0x7e86...`: GoPlus clean, LP at or below USD 10,000.

## What this does not establish

- 48 tokens from discovery were never queried on GoPlus (13 with search liquidity of USD 5,000 or more, mostly below USD 10,000), and DexScreener search is capped at 30 pools per query, so the set is not exhaustive.
- Decisions are point-in-time (TTL 600 s); each token was evaluated at its own time, between 02:46Z and 03:48Z, and thin pools can move.
- Tokenized stocks (for example SPY, NVDA, MSTR, AAPL) were out of scope; the ones run through the audit were Pending on missing GoPlus fields.
- A pass attests the reference token under policy v1, not that it is a good or safe asset. No simulation of buys and sells was run (D10).

## Owner selection for the demo (2026-11-09)

The owner chose these six tokens as the reference tokens of the hackathon demo, from the 11 that pass audit policy v1 today: **CASHCAT, WALLET, GOOD, AI, VLAD, DEGEN**.

| Token | Mainnet 4663 address |
| --- | --- |
| CASHCAT | `0x020bfC650A365f8BB26819deAAbF3E21291018b4` |
| WALLET | `0x0339f5459fC690ac85f1782E15782A151b4a9e1b` |
| GOOD | `0x5F62c57E5C537887117eEF828b7e3aD41C009FEb` |
| AI (Affair Inu) | `0x0d4a117DCcCe7ba3D0a475ec9068c20C35310Fd8` |
| VLAD (The Robinhood) | `0xFDbB27E971E72E38C41b1c772FB409c94dd92789` |
| DEGEN | `0x0830a9dD26A04E959657aB6788d45F5725590c32` |

Why these six: all have Sourcify-verified source, no clone and no active whitelist, 18 decimals, about 1B supply (DEGEN 1.195B), and counted liquidity between USD 15,850 and USD 990,012. Excluded on purpose: BTCETHUSDT (thin margin over USD 10,000 and an on-chain name made of hundreds of other coins' names, which is untrusted text that can break a UI or a terminal prompt); HOODRAT, SANTACOIN and WIF (source not verified); moon (clone, 5% tax at the cap).

Known risks the owner accepted for the demo: WALLET is not a memecoin by theme and imitates a Robinhood product name (another token named WALLET exists); AI and VLAD share tickers with other tokens, so the registry must key on the address, never the ticker; most of the six rest on a single pool of USD 16k to 65k, which is easy to move, and the value counted is the quote-side balance, not executable depth (D32). A pass attests audit policy v1 at one point in time only.

Registration: the entries are added to the arena's on-chain reference registry by the protocol account (D33), which is the DAO once it exists. Nothing is registered yet.


Authenticity, look-alike and holder-concentration review of these six (issue #125, 2026-11-09): [token-authenticity.md](token-authenticity.md).
