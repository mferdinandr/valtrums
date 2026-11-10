# Valtrum infrastructure agent

Legacy automation reads arena state to resume audit, pricing and settlement. This is infrastructure, not a user-funded autonomous player agent. Durable reconciliation has limits described below.

Pass order: sample prices, audit `Proposed` battles, lock `Approved` battles with initial 30-minute TWAPs, settle ended `Live` battles, drive pending settlement steps, then (hourly) the liquidity watchdog.

The [Robinhood target](../docs/product-spec.md) is planned: 30-second rounds without TWAP, separate GoPlus/LP audit, per-token payouts and bounded player agents/MCP. Existing TWAP, swaps, bond and credit behavior below describes the current implementation only. Infrastructure credentials never authorize spending player funds. See [current state](../docs/current-state.md) and [planned interfaces](../docs/interfaces.md).

## Run

```bash
pnpm -F @valtrum/agent build
pnpm -F @valtrum/agent start
```

Export configuration into the process environment; the start script does not load a root .env automatically.

Required: `ARENA_CONTRACT_ID`, `AGENT_ACCOUNT_ID`, and exactly one of `AGENT_PRIVATE_KEY` or `AGENT_PRIVATE_KEY_FILE` (see the root `.env.example`). The file variant reads a mounted secret and trims whitespace; setting both or neither is an error. The key is never logged or returned by any endpoint.

Optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_INTERVAL_SECS` | `30` | seconds between passes |
| `WATCHDOG_INTERVAL_SECS` | `3600` | seconds between watchdog checks |
| `BASELINE_STORE_PATH` | `./.agent-state/baselines.json` | liquidity baselines recorded at audit |
| `EXECUTION_MODE` | `mock` | `mock`: the agent reports each step as realized = planned. `onchain`: the arena swaps on its execution DEX and the agent only dispatches steps. `foreign`: the agent executes the steps on an EVM chain through the MPC signer and reports the realized amounts (see below) |
| `EXECUTION_SLIPPAGE_BPS` | `500` | onchain and foreign: tolerance below the quote used for `min_out`, integer 0 to 9999 |
| `STEP_TIMEOUT_SECS` | `600` | onchain: a dispatched step older than this is logged as stuck |
| `MARKET_DATA` | `dexscreener` | `dexscreener`: prices, liquidity and the honeypot heuristic come from DexScreener. `mockdex`: they come from the arena's execution DEX (see "Testnet demo"). `ref`: they come from the exchange pools the swap adapter routes through (see "Exchange pools") |
| `REF_EXCHANGE_ID` | unset | required with `MARKET_DATA=ref`: the exchange contract account, for example `ref-finance-101.testnet` |
| `TWAP_WINDOW_SECS` | `1800` | TWAP window for initial and final prices, integer 30 to 604800 and at least `2 * AGENT_INTERVAL_SECS` |
| `MIN_LIQUIDITY_USD` | `10000` | an audited token needs more than this much liquidity, whole USD, integer 1 to 10^12 |
| `HEALTH_PORT` | `8080` | port of the health server, `0` disables it |
| `IMAGE_DIGEST` | `unknown` | image digest reported by `/attestation`, set by the deployer |
| `AGENT_VERSION` | `unknown` | version reported by `/attestation` (the Docker image sets it from a build arg) |

## Health endpoints

- `GET /healthz`: liveness, `200` while the process answers.
- `GET /readyz`: `200` once a pass finished without errors, and while the last such pass is at most 3 intervals old; otherwise `503`. A pass that logged any per-battle error (or an execution mode mismatch) does not count.
- `GET /attestation`: `{ image_digest, version, agent_account_id, execution_mode, contract_id }`. Public, non-secret values only.

## Container

`agent/Dockerfile` builds a non-root image whose only writable path is `/var/lib/valtrum-agent` (the default `BASELINE_STORE_PATH`). See `deploy/README.md` for build, run and TEE notes.

## Execution modes

The mode must match the arena: `onchain` needs `execution_dex` set in `get_config`, `mock` and `foreign` need it unset (and `foreign` needs `get_foreign_config` to return a configuration) (the contract refuses `report_execution` otherwise). The agent checks this at startup and on every pass; on a mismatch it logs an error and skips settlement (`settle_battle` and step work) while the audit, price lock and watchdog keep running.

In `onchain` mode, for the first not-done step of a `Settling` battle:

- not dispatched: compute `min_out` and call `execute_step`. `Return` and zero-amount steps need no `min_out` and are booked by the contract at once.
- dispatched: wait. Later passes only poll the plan, so a step is never dispatched twice. A swap the DEX refuses sets `dispatched` back to `false` and is retried with a fresh `min_out`.

`min_out` = `floor(quote * (10000 - EXECUTION_SLIPPAGE_BPS) / 10000)`, at least 1, where the quote comes from the mock DEX view `get_rate { token_in, token_out }` (`out = in * num / den`, floored) on the account in `execution_dex`. Dump quotes loser coin to USDC; Buy and Burn quote USDC to the winner coin. A zero quote, a missing rate or a failing view means nothing is dispatched and the step is retried next pass.

## Foreign-chain execution (`EXECUTION_MODE=foreign`)

> **Warning: this path moves real value on a real chain.** Exercise it first on Base Sepolia (chain id 84532) with test tokens, and only then, deliberately, on any other chain. The agent signs through the arena, so a wrong token map, router or fee tier can send funds to the wrong place within the limits the contract enforces (router, treasury and burn addresses only).

The owner configures the signer, chain, router, treasury and burn addresses with `set_foreign`; `execution_dex` stays unset. Each battle signs from its own EVM address, derived by the signer from the arena account and the path `valtrum-battle-<id>`. That address must hold the loser coin and some native coin for gas before settlement; nothing in this repository moves funds there.

Per plan step, in order, the executor does the following. All of it is derived from chain state (the plan's `done` flags, the battle's signature requests, receipts, the token allowance), so a restart resumes instead of repeating.

1. Dump: swap the loser coin for USDC. Buy: swap USDC for the winner coin. Burn: swap USDC for the winner coin with the burn address as recipient. Return: transfer USDC to the treasury address. Swaps use Uniswap V3 `exactInputSingle` on the configured router with the configured fee tier. A zero-amount step is reported as 0 without a transaction.
2. Check the wallet holds enough of the token to spend, and read the quote (`min_out`) from the quoter. No quote, no signature (nothing is sent, not even an approval).
3. If the router's allowance is below the amount, request, send and confirm an `approve` for exactly that amount first. An allowance that is already enough skips it.
4. Request the signature with `request_signature` (nonce from the pending transaction count, fees from the node, gas limit = estimate + 20%), poll `get_signature_request`, and on `Failed` call `retry_signature` while the contract allows it (5 attempts).
5. Check the signed bytes (hash, chain id, target contract, calldata), send them unless the node already knows the transaction, and wait for the receipt with the configured confirmations.
6. The realized amount is the sum of ERC-20 `Transfer` logs of the proceeds token to the step's recipient (USDC at the wallet for Dump, the winner coin at the wallet for Buy, the winner coin at the burn address for Burn, USDC at the treasury for Return). `report_execution` is then called once by the settlement driver.

A reverted transaction is never reported: the executor raises an error and the battle stays stopped (later passes find the same reverted receipt and raise it again) until someone intervenes. The same holds for exhausted signature attempts, a nonce used by another transaction, and an unfunded wallet; a signature or receipt that is merely slow is picked up again on the next pass.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FOREIGN_RPC_URL` | required | EVM JSON-RPC endpoint. `https`, or `http` for localhost. May contain an API key: never logged |
| `FOREIGN_CHAIN_ID` | required | must equal the chain id in the arena's `get_foreign_config` and the one the RPC serves |
| `FOREIGN_CONFIRMATIONS` | `3` | blocks (including the inclusion block) before a receipt counts, 1 to 100 |
| `FOREIGN_USDC_ADDRESS` | required | USDC on the foreign chain |
| `FOREIGN_TOKEN_MAP` | required | JSON object of NEAR token account id to EVM address, e.g. `{"pepe.testnet":"0x..."}` |
| `FOREIGN_FEE_TIER` | `3000` | Uniswap V3 pool fee: 100, 500, 3000 or 10000 |
| `FOREIGN_QUOTER_ADDRESS` | required | Uniswap V3 QuoterV2, read with `eth_call` for `min_out` |

Startup fails with a message naming the variable for any missing or malformed value. The agent logs the chain id and a warning that real value moves, never the RPC URL or the key.

Assumptions and limits of this mode:

- The EVM address of a path comes from the signer's `derived_public_key` view (arguments `path`, `predecessor` = arena account, `domain_id` = 0), not from a local key derivation. The key-to-address conversion (keccak of the 64-byte public key) is tested against a known vector; the view's arguments and the `secp256k1:<base58>` key format are taken from the signer's documented interface and have not been run against a live signer from here. The agent does not recover the signer from signed transactions, so a mismatch shows up as an unfunded or wrong address, not as a local check.
- Token amounts are used as they are: the NEAR and EVM versions of a token must have the same decimals.
- Fees are fixed when the request is made (twice the next base fee plus the node's tip). A transaction that stays unmined because fees rose is not replaced; it is waited for on every pass.
- Requests of a step are found by scanning the newest 500 signature requests.
- Confirmations protect against shallow reorganisations only.
- Polling is every 5 seconds, up to 40 polls for a signature and 60 for a receipt per pass; then the pass stops for that battle and the next one resumes.

## RPC endpoints

`NEAR_RPC_URL` selects the node. Public endpoints rate-limit (HTTP 429): the agent retries read-only calls on 429, 5xx and network errors with exponential backoff (up to 5 attempts, 1 s to 15 s), but a busy public endpoint can still starve it. For anything longer than a quick test use a dedicated or less loaded provider, for example `https://test.rpc.fastnear.com` on testnet. Transactions are not retried blindly; the next pass rebuilds the work from on-chain state.

## Opt-in observability (both off by default)

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUDIT_REPORT_ARCHIVE_ENABLED` | unset | `true` archives every lifecycle audit report to a durable append-only file; requires `AUDIT_ENABLED=true` (startup fails otherwise) |
| `AUDIT_REPORT_ARCHIVE_PATH` | `./.agent-state/audit-reports/archive.json` | archive file. `AUDIT_ARCHIVE_PATH` (the read API / MCP name) is an alias for the same file; both may be set only if equal, otherwise startup fails |
| `INDEXER_ENABLED` | unset | `true` runs the read-only event indexer on every pass. There is no live block source yet, so `INDEXER_RECORDED_CHAIN` is required and its blocks and finality are **fixture assertions**, not chain state |
| `INDEXER_RECORDED_CHAIN` | unset | recorded chain file (`arena-indexer-recorded-v1`) |
| `INDEXER_CONTRACTS` | arena only | extra comma-separated emitter accounts to allowlist (for example the backing and payout contracts) |
| `INDEXER_STATE_DIR` | `./.agent-state/indexer` | indexer state directory (single writer) |
| `INDEXER_RETENTION_DEPTH` | `10000` | finalized blocks kept behind the finalized head; older ones become a hashed summary checkpoint and are pruned (provisional blocks and dedup keys never are) |
| `INDEXER_ANCHOR_HEIGHT`, `INDEXER_ANCHOR_HASH` | lowest recorded height, genesis | declared start of the processed chain |

The indexer has no write authority and an indexer failure never blocks settlement or payout passes.

## Limits

- The contract stores no liquidity baseline, so it is kept locally. If the file is lost, the watchdog takes the current liquidity as the new baseline (logged), and a drop before that point goes unnoticed.
- Price history for TWAPs accrues from the agent's own samples; after a long outage the fetcher refuses to write prices until enough history exists.
- Final prices use the 30 minutes before the pass that settles, so settle promptly after `end_time`.
- The contract has no reset method for a dispatched step that never gets proceeds. The agent logs `STUCK STEP` (battle id, step index) once per timeout period and does not retry. The timer starts when the agent first sees the dispatch, so it restarts after an agent restart.
- `min_out` protects against price moves between the quote and the swap. Quotes come from the mock DEX's `get_rate`, or from the exchange's `get_return` when `MARKET_DATA=ref`; another DEX needs another `QuoteSource` implementation.

## Exchange pools (`MARKET_DATA=ref`)

With the swap adapter as the arena's execution DEX, the agent reads the pools it routes through. The adapter is `get_config().execution_dex`, USDC is `get_config().usdc`, and `REF_EXCHANGE_ID` names the exchange.

- Pool: `get_pool { token_in: <usdc>, token_out: <coin> }` on the adapter gives the pool id; `get_pool { pool_id }` on the exchange gives the reserves.
- Price: USD per whole coin scaled by 1e18, the spot ratio of the reserves, `usdc * 10^(decimals + 12) / coin`, floored. A coin with no routed pool, or an empty one, is unpriced and retried, never treated as worthless.
- Liquidity: twice the pool's USDC side, in whole USD.
- Honeypot check: passes only if the coin has a routed USDC pool with reserves on both sides. This is a heuristic, not a simulated sale.
- Quotes: `get_return` on the exchange (fee included) for `min_out`.
- Settlement steps get the full 300 Tgas because the swap runs arena, adapter, exchange and back.

Run only one agent per arena key. Two agents with the same key and different market data lock and settle the same battle with different prices, which can void it.

## Testnet demo (`MARKET_DATA=mockdex`)

Mock tokens are unknown to DexScreener, so on testnet the agent reads the mock DEX instead. The DEX account is `get_config().execution_dex` and USDC is `get_config().usdc`; the agent refuses to start if `execution_dex` is unset.

- Price: USD per whole coin scaled by 1e18, from `get_rate { token, usdc }` and the token's `ft_metadata` decimals (read once), floored with exact integer math: `num * 10^(decimals + 12) / den`. USDC is $1 with 6 decimals.
- Liquidity: `get_liquidity { token }` valued at that price in USD; USDC at face value. A token without a usable rate counts as zero liquidity. Because liquidity is valued, a price drop of more than 50% trips the watchdog just like a liquidity cut does.
- Honeypot check: passes only if token to USDC and USDC to token both have a non-zero rate and the DEX holds some of the token.

The DEX owner moves a price by setting a new rate, for example `set_rate { token_in: <coin>, token_out: <usdc>, num, den }` (`out = in * num / den`). The agent samples the rate every pass, so the new price shows up in the next samples and in the TWAP as a time-weighted blend. Cutting a token's `get_liquidity` by more than half makes the next watchdog check halt the battle; set `WATCHDOG_INTERVAL_SECS` low (for example `30`) in a demo.

Coverage rule for the TWAP: a price is written only if the first sample lies at most `max(window * 0.2, AGENT_INTERVAL_SECS)` after the window start, so history has to span at least `window - max(0.2 * window, interval)`. With the default 1800 s window this is 24 minutes. With `TWAP_WINDOW_SECS=60` and the 30 s pass interval it is 30 seconds, so two samples are enough. Thinner history is refused and retried on the next pass; no price is made up.

Minimum battle timeline with `TWAP_WINDOW_SECS=60`, `AGENT_INTERVAL_SECS=30` (times from the first pass that sees the battle):

1. 0 s: audit and approve. Tokens are sampled from the next pass on.
2. Deposits stay open until `deposit_deadline`, which the contract sets when the battle is proposed.
3. The initial prices need 2 samples, so the lock happens about 60 s after approval at the earliest (and not before the deposit deadline).
4. The battle ends `duration` after the lock. Final prices need the same 60 s of history, so settle after `end_time` with samples from the last minute; keep the agent running throughout.

With the default window the same steps take roughly 25 minutes before a lock and 30 minutes of history before settlement.

## Intents fixture (`intents-fixture`, testnet only)

NEAR Intents lists no testnet asset, so the testnet demo uses a local **fixture** of the 1Click API (D29). It is not NEAR Intents and proves no Intents integration; the real `intents` route stays refused.

- `NEAR_NETWORK=testnet pnpm build && pnpm intents:fixture` serves `/v0/tokens`, `/v0/quote`, `/v0/deposit/submit` and `/v0/status` on `127.0.0.1:${INTENTS_FIXTURE_PORT:-8791}`. It refuses to start unless the network is testnet and sends or reads no credentials. `PUT /fixture/solver-mode` with `{"mode":"complete"|"fail"|"refund"}` drives the fake solver.
- `INTENTS_FIXTURE=1` makes the action service accept `route: "intents-fixture"` on deposits (testnet only; the service refuses to start on any other network). Every preview, status, response and log line carries the fixture label.
- Tests: `test/intents-fixture/` (golden and drift tests against `docs/evidence/2026-11-09-intents-routes.json`, solver, route, server and trace tests; no network). Mapping and migration: `docs/intents-asset-mapping.md`.


## Audit archive: producer and consumer config

The agent writes the archive; the read API / MCP (`pnpm -C agent read:serve` or `read:mcp`) reads it through `inspect_audit`. Point both at the same file (non-secret example values):

```
# agent
AUDIT_ENABLED=true
AUDIT_REPORT_ARCHIVE_ENABLED=true
AUDIT_REPORT_ARCHIVE_PATH=/var/lib/valtrum/audit-reports/archive.json
# read API / MCP (either name; AUDIT_REPORT_ARCHIVE_ENABLED=true alone selects the default path)
AUDIT_ARCHIVE_PATH=/var/lib/valtrum/audit-reports/archive.json
ARENA_CONTRACT_ID=arena.example.testnet
```

- The reader returns only observations attributed to its own `ARENA_CONTRACT_ID`.
- The read source is always labeled `recorded`. Each observation carries its own `provenance` (`recorded` as written by the agent); no environment flag upgrades it to `live`.
- `inspect_audit` keeps the historical `result`, the read-time `freshness` (`fresh`/`expired`/`not_applicable`) and `currentApproval: notEstablished` separate. An empty answer is labeled (archive missing, producer disabled or battle not audited yet); a corrupt archive is an error, not an empty history.
- Retention: there is no pruning; capacity is finite and a full archive is a visible sink error. Retention policy is an open decision.

## Payout roles (relayer and operator)

Two separate processes, each with its own NEAR account and key. A process refuses to start if the other role's variables or the arena agent key (`AGENT_PRIVATE_KEY[_FILE]`) are in its environment. The browser, the read API/MCP and the arena agent never hold either key. The arena agent's optional reconciler (`PAYOUT_RECONCILE_ENABLED`) is unchanged: it never requests signatures and never holds the operator key.

| Variable | Role | Meaning |
| --- | --- | --- |
| `PAYOUT_CONTRACT_ID`, `PAYOUT_EVM_RPC_URL` (https), `PAYOUT_CHAIN_ID`, `PAYOUT_INTERVAL_SECS` | both | payout contract, source-chain read RPC (may embed a key: not logged), the one chain every payout must name, pass interval (default 30, min 5) |
| `PAYOUT_RELAYER_ACCOUNT_ID`, `PAYOUT_RELAYER_PRIVATE_KEY` or `_FILE` | relayer | must be the relayer fixed at payout contract initialization |
| `PAYOUT_RELAYER_MAX_FEE_PER_GAS_WEI` | relayer | fee cap of the first request; the contract still enforces its registered cap |
| `PAYOUT_SIGNING_GRACE_SECS` | relayer | how long a signer answer may be missing before the payout is held (default 300) |
| `PAYOUT_OPERATOR_ACCOUNT_ID`, `PAYOUT_OPERATOR_PRIVATE_KEY` or `_FILE` | operator | must be the operator fixed at initialization |
| `PAYOUT_OPERATOR_SUBMIT` | operator | `true` submits confirm/revert/restore; default is a dry run that logs the checked proof |

Run: `pnpm -C agent build`, then `pnpm -C agent payout:relayer` and `pnpm -C agent payout:operator`.

- **Relayer pass:** reconcile existing attempts first (rebroadcast the stored signed transaction, record broadcast/pending, hold on missing evidence), then `request_signature` for an `authorized` payout that has no attempt, names the configured chain, whose nonce slot is unused and which reconciliation cleared. Eligibility comes from contract state, so a restart, lost response or duplicate pass never creates a second request; a failed or unconfirmed request is logged and never retried in the same pass.
- **Operator pass:** reads from its own RPC, builds the proof from finalized chain state, re-checks it against the payout's contract view, then submits. It confirms only an exact finalized transfer (token, sender, destination, amount) of a recorded attempt; it restores only after every attempt is proven reverted and the nonce slot is finalized. Wrong or partial evidence, a used nonce without a matching receipt, a reorg or a client timeout leave the payout open (`reconciliation_required`); a timeout never restores liability.
- **Status references** (for the read API and portfolio): structured log lines `payout relayer pass` (`requested`, `skipped[]`, `errors`), `payout operator pass` (`results[]` with `submitted|dry_run|refused|failed`, `unresolved`, `errors`), `payout reconciled` (per payout `kind`) and the contract's `get_payout` / `list_open_payouts` state. A signature, a pending transaction or a timeout is never delivered or restored funds; only `confirmed` and `restored` are terminal.
- **Restart/recovery:** just restart the process. No in-memory state is required for safety. After an operator `failed` result, check `get_payout` and let the next pass re-read the chain.
- **Not live proof:** everything above is fixture-tested. Live release stays gated by #148 (custody spendability) and #80 (end-to-end acceptance).
