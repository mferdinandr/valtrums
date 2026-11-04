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
| `EXECUTION_MODE` | `mock` | `mock`: the agent reports each step as realized = planned. `onchain`: the arena swaps on its execution DEX and the agent only dispatches steps |
| `EXECUTION_SLIPPAGE_BPS` | `500` | onchain: tolerance below the DEX quote used for `min_out`, integer 0 to 9999 |
| `STEP_TIMEOUT_SECS` | `600` | onchain: a dispatched step older than this is logged as stuck |
| `MARKET_DATA` | `dexscreener` | `dexscreener`: prices, liquidity and the honeypot heuristic come from DexScreener. `mockdex`: they come from the arena's execution DEX (see "Testnet demo") |
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

The mode must match the arena: `onchain` needs `execution_dex` set in `get_config`, `mock` needs it unset (the contract refuses `report_execution` otherwise). The agent checks this at startup and on every pass; on a mismatch it logs an error and skips settlement (`settle_battle` and step work) while the audit, price lock and watchdog keep running.

In `onchain` mode, for the first not-done step of a `Settling` battle:

- not dispatched: compute `min_out` and call `execute_step`. `Return` and zero-amount steps need no `min_out` and are booked by the contract at once.
- dispatched: wait. Later passes only poll the plan, so a step is never dispatched twice. A swap the DEX refuses sets `dispatched` back to `false` and is retried with a fresh `min_out`.

`min_out` = `floor(quote * (10000 - EXECUTION_SLIPPAGE_BPS) / 10000)`, at least 1, where the quote comes from the mock DEX view `get_rate { token_in, token_out }` (`out = in * num / den`, floored) on the account in `execution_dex`. Dump quotes loser coin to USDC; Buy and Burn quote USDC to the winner coin. A zero quote, a missing rate or a failing view means nothing is dispatched and the step is retried next pass.

## Limits

- The contract stores no liquidity baseline, so it is kept locally. If the file is lost, the watchdog takes the current liquidity as the new baseline (logged), and a drop before that point goes unnoticed.
- Price history for TWAPs accrues from the agent's own samples; after a long outage the fetcher refuses to write prices until enough history exists.
- Final prices use the 30 minutes before the pass that settles, so settle promptly after `end_time`.
- Foreign-chain execution of settlement steps is an extension point (`ForeignChainStepExecutor`) and throws if used.
- The contract has no reset method for a dispatched step that never gets proceeds. The agent logs `STUCK STEP` (battle id, step index) once per timeout period and does not retry. The timer starts when the agent first sees the dispatch, so it restarts after an agent restart.
- `min_out` protects against DEX rate changes only; quotes are read from the mock DEX, so a different DEX needs another `QuoteSource` implementation.

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
