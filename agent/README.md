# Valtrum agent

Automation for the arena contract. Every pass reads on-chain state and acts on it, so restarts and duplicate passes never repeat completed work.

Pass order: sample prices, audit `Proposed` battles, lock `Approved` battles with initial 30-minute TWAPs, settle ended `Live` battles, drive pending settlement steps, then (hourly) the liquidity watchdog.

## Run

```bash
pnpm -F @valtrum/agent build
pnpm -F @valtrum/agent start
```

Required: `ARENA_CONTRACT_ID`, `AGENT_ACCOUNT_ID`, `AGENT_PRIVATE_KEY` (see the root `.env.example`). The key is never logged.

Optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_INTERVAL_SECS` | `30` | seconds between passes |
| `WATCHDOG_INTERVAL_SECS` | `3600` | seconds between watchdog checks |
| `BASELINE_STORE_PATH` | `./.agent-state/baselines.json` | liquidity baselines recorded at audit |
| `EXECUTION_MODE` | `mock` | only `mock` exists in this build; steps are reported as realized = planned |

## Limits

- The contract stores no liquidity baseline, so it is kept locally. If the file is lost, the watchdog takes the current liquidity as the new baseline (logged), and a drop before that point goes unnoticed.
- Price history for TWAPs accrues from the agent's own samples; after a long outage the fetcher refuses to write prices until enough history exists.
- Final prices use the 30 minutes before the pass that settles, so settle promptly after `end_time`.
- Foreign-chain execution of settlement steps is an extension point (`ForeignChainStepExecutor`) and throws if used.
