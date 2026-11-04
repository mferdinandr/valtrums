# Valtrum agent

Automation for the arena contract. Every pass reads on-chain state and acts on it, so restarts and duplicate passes never repeat completed work.

Pass order: sample prices, audit `Proposed` battles, lock `Approved` battles with initial 30-minute TWAPs, settle ended `Live` battles, drive pending settlement steps, then (hourly) the liquidity watchdog.

## Run

```bash
pnpm -F @valtrum/agent build
pnpm -F @valtrum/agent start
```

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

## Limits

- The contract stores no liquidity baseline, so it is kept locally. If the file is lost, the watchdog takes the current liquidity as the new baseline (logged), and a drop before that point goes unnoticed.
- Price history for TWAPs accrues from the agent's own samples; after a long outage the fetcher refuses to write prices until enough history exists.
- Final prices use the 30 minutes before the pass that settles, so settle promptly after `end_time`.
- The contract has no reset method for a dispatched step that never gets proceeds. The agent logs `STUCK STEP` (battle id, step index) once per timeout period and does not retry. The timer starts when the agent first sees the dispatch, so it restarts after an agent restart.
- `min_out` protects against DEX rate changes only; quotes are read from the mock DEX, so a different DEX needs another `QuoteSource` implementation.
