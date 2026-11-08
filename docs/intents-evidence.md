# Intents and Bitte evidence

Recorded evidence for issue [#78](https://github.com/mferdinandr/valtrum/issues/78). Raw responses: [`evidence/2026-11-09-intents-routes.json`](evidence/2026-11-09-intents-routes.json). Only the public 1Click API was called: `GET /v0/tokens`, and `POST /v0/quote` with `dry: true`. Without `dry: false` no deposit address exists, so no funds could move. No API key was used, and the probe recipient and refund addresses are not ours.

## 1. Intents asset discovery and quotes (recorded 2026-11-08 22:00 UTC)

**Asset discovery.** `GET /v0/tokens` returned 216 assets on 39 chains. Robinhood Chain **mainnet** appears as blockchain `hood` with 6 assets:

| Symbol | assetId | Contract |
| --- | --- | --- |
| USDG | `nep141:hood-0x5fc5…d168.omft.near` | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` (the audit's verified stablecoin) |
| WETH | `nep141:hood-0x0bd7…ad73.omft.near` | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` (the audit's verified WETH) |
| ETH | `nep141:hood.omft.near` | native |
| CASHCAT | `nep141:hood-0x020b…18b4.omft.near` | `0x020bfc650a365f8bb26819deaabf3e21291018b4` (a candidate reference token) |
| USDe | `nep141:hood-0x5d3a…ef34.omft.near` | `0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34` |
| PONS | `nep141:hood-0x39db…4571.omft.near` | `0x39dbed3a2bd333467115de45665cc57f813c4571` |

**No testnet asset is listed** on any chain: neither Robinhood testnet `46630` nor NEAR testnet.

**Quotes (dry, mainnet).** 10 USDC on NEAR (`nep141:1720…33a1`), `EXACT_INPUT`, 1% slippage, origin chain to destination chain:

| Destination | amountOut | minAmountOut | Time estimate |
| --- | --- | --- | --- |
| CASHCAT (Robinhood) | 140.498 CASHCAT | 139.093 | 21 s |
| USDG (Robinhood) | 9.904 USDG | 9.805 | 19 s |
| ETH (Robinhood) | 0.004673 ETH | 0.004626 | 19 s |

A recipient of `0x…dEaD` was refused (`recipient is not valid`), so the arena's burn sink cannot be used directly as a 1Click recipient.

**What this does not prove:**
- no funding authorization, deposit, execution or refund status;
- no solver identity (that needs a committed quote);
- no route to the arena's custody receipt.

## 2. Bitte orchestration: not verified

No Bitte account or agent is configured for this project, so no orchestration of a canonical arena preview has been recorded. The arena side is ready for it: the #76 action boundary exposes canonical previews, NEP-413 authorization and status, and the #77 proposals path accepts untrusted agent output. A Bitte agent would call those, and orchestration alone supplies no solver, bridge or receipt verifier.

## 3. Binding action, preview, authorization, route status and custody receipt: not verified

This needs the target testnet deployment (see [testnet-evidence.md](testnet-evidence.md)), a supported route, and a funded user action. None of these exist yet.

## 4. Integration gaps

- **Intents on testnet:** 1Click lists no testnet assets, so no Intents route exists for Robinhood testnet `46630` or NEAR testnet. Testnet funding through Intents is an **integration gap**.
- **Arena boundary:** it refuses every route except `direct` (`unsupported_route`, #76) before anything is built or stored, and the terminal's mock funding router is labelled a fixture.
- **Mainnet routes:** they exist for Robinhood assets (above), but the project targets testnet only, so they are research evidence, not an accepted route.
- **Direct deposits:** a direct Robinhood testnet deposit exercises custody but does **not** complete Intents or Bitte acceptance.
- **Bitte:** a gap until an account and agent exist.
