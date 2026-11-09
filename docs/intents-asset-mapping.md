# Intents fixture: asset mapping and migration note

Owner decision D29 (2026-11-09, issue [#114](https://github.com/mferdinandr/valtrum/issues/114)). NEAR Intents (1Click) lists **no testnet asset** ([intents-evidence.md](intents-evidence.md)), and the hackathon handbook says no testnet Intents exists or is planned. The testnet demo therefore uses a **fixture** of the 1Click API: `agent/src/intents-fixture/`, a fake solver that moves testnet mock tokens, and the funding route `intents-fixture`.

**This is a fixture, not NEAR Intents.** It proves nothing about a real solver, route, price or refund. The real `intents` route stays an integration gap, and the arena refuses it (`unsupported_route`).

## What is real and what is fixture

| Piece | Status |
| --- | --- |
| Paths `GET /v0/tokens`, `POST /v0/quote`, `POST /v0/deposit/submit`, `GET /v0/status` | Names and fields taken from the official OpenAPI (`https://1click.chaindefuser.com/docs/v0/openapi.yaml`) and the 1Click docs. |
| Dry-quote amounts, `minAmountOut`, `timeEstimate`, asset decimals and field formats | Pinned by golden and drift tests to the recorded mainnet responses in [`evidence/2026-11-09-intents-routes.json`](evidence/2026-11-09-intents-routes.json). |
| Prices and rates | The recorded dry quote for 10 USDC, scaled linearly. A fixture rate, not a market. |
| Solver, deposit detection, refund, failure | Invented by the fixture. No real solver behaves this way by contract. |
| Custody | An in-memory ledger. Not the EVM custody contract and not the receipt registry. |
| Asset ids and contract addresses of the mocks | **Placeholders** until the testnet mock tokens exist (#72). |

## Asset mapping

The fixture lists and accepts only the fixture id. The mainnet id is the real 1Click asset id the mock stands in for; both columns come from `agent/src/intents-fixture/assets.ts`.

| Symbol | Mainnet id (recorded, real) | Fixture id (placeholder) | Decimals | Fixture quote |
| --- | --- | --- | --- | --- |
| USDC (origin, NEAR) | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | `nep141:mock-usdc.fixture.testnet` | 6 | origin only |
| USDG | `nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near` | `nep141:mock-hood-usdg.fixture.testnet` | 6 | recorded |
| CASHCAT | `nep141:hood-0x020bfc650a365f8bb26819deaabf3e21291018b4.omft.near` | `nep141:mock-hood-cashcat.fixture.testnet` | 18 | recorded |
| ETH (native) | `nep141:hood.omft.near` | `nep141:mock-hood-eth.fixture.testnet` | 18 | recorded |
| WETH | `nep141:hood-0x0bd7d308f8e1639fab988df18a8011f41eacad73.omft.near` | `nep141:mock-hood-weth.fixture.testnet` | 18 | listed only, no quote |
| USDe | `nep141:hood-0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34.omft.near` | `nep141:mock-hood-usde.fixture.testnet` | 18 | listed only, no quote |
| PONS | `nep141:hood-0x39dbed3a2bd333467115de45665cc57f813c4571.omft.near` | `nep141:mock-hood-pons.fixture.testnet` | 18 | listed only, no quote |

- Fixture listings use the mainnet `blockchain` values (`near`, `hood`) so the response shape matches. Real `hood` is Robinhood **mainnet**; the fixture's `hood` assets are testnet (46630) mocks. The fixture's contract addresses are derived placeholders (`sha256("valtrum-fixture-mock:<symbol>")`), not deployed contracts.
- This table is not the reference-token registry. The registry (D21) maps each testnet mock to a Robinhood mainnet **reference token** for audit and scoring; this table maps a mock to the **1Click asset id** it simulates. Neither implies the other.
- Quoting is limited to origin USDC to a destination with a recorded quote. Anything else answers `400 no route is available for this asset pair`.

## Using the fixture

```bash
NEAR_NETWORK=testnet pnpm -C agent build && pnpm -C agent intents:fixture   # 127.0.0.1:8791
curl -X PUT 127.0.0.1:8791/fixture/solver-mode -d '{"mode":"refund"}'        # complete | fail | refund
```

- The service refuses to start unless `NEAR_NETWORK` is `testnet`. It binds loopback only and reads or sends no credentials.
- Every quote and status body carries `valtrumFixture` (an extra key the real API does not have), every response carries the header `x-valtrum-fixture: true`, and every log line carries `fixture: true`, `route: "intents-fixture"` and the label.
- Status flow after `POST /v0/deposit/submit`: `KNOWN_DEPOSIT_TX`, then each `GET /v0/status` poll advances one step to `PROCESSING`, then the solver settles to `SUCCESS`, `REFUNDED` or `FAILED`. A terminal state never changes, so repeated polls cannot settle or credit twice.
- The action service accepts a deposit with `route: "intents-fixture"` only when `INTENTS_FIXTURE=1` **and** the network is testnet (`ActionService` refuses to start otherwise). The preview binding, limitations, the `action_status` attribution (`route: {name, fixture, label}`) and the terminal result all carry the label. It is refused through grants.

## Migration note: from the fixture to a real route

When 1Click lists a testnet asset (or the project accepts a mainnet route with tiny amounts and `dry: true` quotes, as the handbook suggests):

1. Point `ONECLICK_API_URL` at `https://1click.chaindefuser.com` (the current default) and stop running the fixture. Do not send the fixture's placeholder ids anywhere: replace each fixture id with the id returned by `GET /v0/tokens` (never build ids by hand).
2. Replace the placeholder contract addresses with the deployed mock tokens (#72) and update the table above.
3. Drop the fake solver and the in-memory custody. The custody receipt must come from the real receipt path (`custody-verifier.ts`, receipt registry), bound to the same preview and authorization.
4. Add the real route name to `SUPPORTED_FUNDING_ROUTES` only after the integration tasks in `arena-testnet-integrations` (asset discovery, committed quote, real funding and refund status, solver identity, custody receipt binding) are verified with live evidence. Until then `intents` stays `unsupported_route`.
5. Remove `INTENTS_FIXTURE`, the `intents-fixture` route and the `valtrumFixture` label handling, or keep them only for offline demos, still labelled.
6. Re-record the responses (public read-only `GET /v0/tokens` and `POST /v0/quote` with `dry: true`, no credentials) and re-run the drift tests. They fail when the real shape moves away from the fixture.
7. Re-check what the fixture assumed (see [intents-evidence.md](intents-evidence.md), section 5), notably the error body shape, refund semantics and status progression.
