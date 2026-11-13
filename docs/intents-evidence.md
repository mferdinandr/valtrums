# Intents and Bitte evidence

> **Note (2026-11-14):** The Robinhood Chain testnet custody, the EVM contracts and payouts to Robinhood are retired, and cross-chain funding through NEAR Intents is not part of the application. Valtrums now runs on NEAR only; Robinhood Chain mainnet is only read for prices and token audits. This page is historical research. See [current state](current-state.md).

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
- **Arena boundary:** it refuses every route except `direct` and, in a testnet configuration only, the labelled `intents-fixture` (`unsupported_route` for the rest, #76) before anything is built or stored, and the terminal's mock funding router is labelled a fixture.
- **Mainnet routes:** they exist for Robinhood assets (above), but the project targets testnet only, so they are research evidence, not an accepted route.
- **Direct deposits:** a direct Robinhood testnet deposit exercises custody but does **not** complete Intents or Bitte acceptance.
- **Bitte:** a gap until an account and agent exist.
- **Fixture (D29):** a local fixture of the 1Click API with a fake solver gives the testnet demo a funding path (route `intents-fixture`). It is **not** evidence of Intents: see section 5 and [intents-asset-mapping.md](intents-asset-mapping.md).

## 5. Testnet fixture (fixture evidence, not Intents evidence)

Issue [#114](https://github.com/mferdinandr/valtrum/issues/114), owner decision D29. Code in `agent/src/intents-fixture/`; tests in `agent/test/intents-fixture/`.

**What the tests prove (fixture against recorded responses, no network):**
- The fixture lists the same six Robinhood assets with the recorded symbols, decimals and field formats, under different (placeholder) asset ids.
- Its dry quotes for 10 USDC reproduce the recorded `amountIn`, `amountOut`, `minAmountOut` and `timeEstimate` exactly, and have no deposit address. A drift test fails when a recorded field is renamed, retyped, reformatted or its recorded absence changes.
- A funded quote reaches `SUCCESS` with a fixture custody receipt; a failing solver ends `FAILED` and a refunding one `REFUNDED`, neither credits, and a replayed receipt credits once. The route `intents-fixture` is accepted only on testnet, other routes stay `unsupported_route`, and labels appear in logs, headers, quote and status bodies, previews, `action_status` and the terminal result.
- [`evidence/2026-11-09-intents-fixture-trace.json`](evidence/2026-11-09-intents-fixture-trace.json) binds the user action, preview hash, NEP-413 authorization, route statuses and the custody receipt in one trace. It is labelled **FIXTURE EVIDENCE**: every actor is the fixture, the fake solver, an in-memory ledger or a scripted receipt verifier.

**What it does not prove:** any real solver, route, quote price, funding or refund behaviour; Bitte; a testnet custody receipt. The live trace needs the testnet accounts and custody from #72 and a real route, and stays an **open item**.

**Verified from the official OpenAPI (2026-11-09, `https://1click.chaindefuser.com/docs/v0/openapi.yaml`, first 100,000 characters read):** the four paths; `TokenResponse` fields; `QuoteRequest` required and optional fields and enums; `QuoteResponse` (`correlationId`, `timestamp`, `signature`, `quoteRequest`, `quote`) and the `Quote` required fields; `SubmitDepositTxRequest/Response`; the `GET /v0/status` query (`depositAddress`, `depositMemo`) and response; the seven status values; `SwapDetails` fields.

**Assumed, not verified (fixture behaviour):**
- The recording is a summary (symbols, ids, decimals, amounts), not a raw capture: `price`, `priceUpdatedAt`, `quote.*Formatted`, `*Usd` and the quote envelope are checked only against the OpenAPI field list, not against recorded values. Recorded `status: "quoted"` and `message: null` are summary fields, not API fields.
- Error bodies: the fixture answers `{ "message": "..." }` with HTTP 400 or 404. Only the text `recipient is not valid` was observed.
- Status progression timing, what `INCOMPLETE_DEPOSIT` and deadline expiry do, and which refund reasons a real solver reports. The fixture never produces `INCOMPLETE_DEPOSIT` and ignores the deadline after the quote.
- That `minAmountOut` uses floor rounding of `amountOut * (10000 - slippage) / 10000`; it matches the three recorded quotes.
- Only `EXACT_INPUT`, `ORIGIN_CHAIN` deposit and refund, and `DESTINATION_CHAIN` recipient are supported by the fixture.
- Dry quotes are unauthenticated and carry the 0.25% unauthenticated fee in reality; the fixture models no fee beyond the recorded amounts.
- The rest of the OpenAPI document (about 1.8 million characters) was not read.

No script refreshes the recording yet; re-recording is a manual, public, read-only, `dry: true` step (open item).
