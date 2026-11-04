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
