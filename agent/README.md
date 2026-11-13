# Valtrum infrastructure agent

Legacy automation reads arena state to resume audit, pricing and settlement. This is infrastructure, not a user-funded autonomous player agent. Durable reconciliation has limits described below.

Pass order: sample prices, audit `Proposed` battles, lock `Approved` battles with initial 30-minute TWAPs, settle ended `Live` battles, drive pending settlement steps, then (hourly) the liquidity watchdog.

The lifecycle arena ([product spec](../docs/product-spec.md)) runs on NEAR testnet: 30-second rounds without TWAP, separate GoPlus/LP audit, per-token rewards claimed on NEAR and bounded player agents/MCP. Robinhood Chain mainnet is only read for prices and liquidity. TWAP, swaps, bond and credit behavior below belongs to the legacy two-side arena. Infrastructure credentials never authorize spending player funds. See [current state](../docs/current-state.md) and [planned interfaces](../docs/interfaces.md).

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
| `EXECUTION_MODE` | `mock` | `mock`: the agent reports each step as realized = planned. `onchain`: the arena swaps on its execution DEX and the agent only dispatches steps |
| `EXECUTION_SLIPPAGE_BPS` | `500` | onchain: tolerance below the quote used for `min_out`, integer 0 to 9999 |
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

The mode must match the arena: `onchain` needs `execution_dex` set in `get_config`, `mock` needs it unset (the contract refuses `report_execution` otherwise). The agent checks this at startup and on every pass; on a mismatch it logs an error and skips settlement (`settle_battle` and step work) while the audit, price lock and watchdog keep running.

In `onchain` mode, for the first not-done step of a `Settling` battle:

- not dispatched: compute `min_out` and call `execute_step`. `Return` and zero-amount steps need no `min_out` and are booked by the contract at once.
- dispatched: wait. Later passes only poll the plan, so a step is never dispatched twice. A swap the DEX refuses sets `dispatched` back to `false` and is retried with a fresh `min_out`.

`min_out` = `floor(quote * (10000 - EXECUTION_SLIPPAGE_BPS) / 10000)`, at least 1, where the quote comes from the mock DEX view `get_rate { token_in, token_out }` (`out = in * num / den`, floored) on the account in `execution_dex`. Dump quotes loser coin to USDC; Buy and Burn quote USDC to the winner coin. A zero quote, a missing rate or a failing view means nothing is dispatched and the step is retried next pass.

## RPC endpoints

`NEAR_RPC_URL` selects the node. Public endpoints rate-limit (HTTP 429): the agent retries read-only calls on 429, 5xx and network errors with exponential backoff (up to 5 attempts, 1 s to 15 s), but a busy public endpoint can still starve it. For anything longer than a quick test use a dedicated or less loaded provider, for example `https://test.rpc.fastnear.com` on testnet. Transactions are not retried blindly; the next pass rebuilds the work from on-chain state.

## Opt-in observability (both off by default)

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUDIT_REPORT_ARCHIVE_ENABLED` | unset | `true` archives every lifecycle audit report to a durable append-only file; requires `AUDIT_ENABLED=true` (startup fails otherwise) |
| `AUDIT_REPORT_ARCHIVE_PATH` | `./.agent-state/audit-reports/archive.json` | archive file. `AUDIT_ARCHIVE_PATH` (the read API / MCP name) is an alias for the same file; both may be set only if equal, otherwise startup fails |
| `INDEXER_ENABLED` | unset | `true` runs the read-only event indexer on every pass. There is no live block source yet, so `INDEXER_RECORDED_CHAIN` is required and its blocks and finality are **fixture assertions**, not chain state |
| `INDEXER_RECORDED_CHAIN` | unset | recorded chain file (`arena-indexer-recorded-v1`) |
| `INDEXER_CONTRACTS` | arena only | extra comma-separated emitter accounts to allowlist (for example the community token contracts) |
| `INDEXER_STATE_DIR` | `./.agent-state/indexer` | indexer state directory (single writer) |
| `INDEXER_RETENTION_DEPTH` | `10000` | finalized blocks kept behind the finalized head; older ones become a hashed summary checkpoint and are pruned (provisional blocks and dedup keys never are) |
| `INDEXER_ANCHOR_HEIGHT`, `INDEXER_ANCHOR_HASH` | lowest recorded height, genesis | declared start of the processed chain |
| `INDEXER_SOURCE` | `recorded` | `near-data` selects the live, finalized-only NEAR Data source (cross-checked against an archival RPC header per block). Never combined with `INDEXER_RECORDED_CHAIN`; finality and completeness are provider-declared, not a cryptographic proof. Setup, trust limits and a full example: `docs/openspec/changes/arena-testnet-integrations/live-source-handoff.md` |
| `INDEXER_GENESIS_HEIGHT`, `INDEXER_GENESIS_HASH`, `INDEXER_PROVIDER_EVIDENCE` | unset | required with `near-data`: the pinned genesis block and the reviewed provider qualification record (a path or short reference). `INDEXER_ANCHOR_HEIGHT` and `INDEXER_ANCHOR_HASH` (parent hash of the first block) are also required |
| `INDEXER_NEARDATA_URL`, `NEAR_RPC_URL` | `https://<network>.neardata.xyz`, `https://archival-rpc.<network>.near.org` | HTTPS origins without credentials, query or redirects; live mode reads at most 20 blocks per pass |

The indexer has no write authority and an indexer failure never blocks settlement passes.

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


## Market observations (journal, reads and collector)

Read-only observation evidence for the round chart (`arena-market-observations`, issue #146). Off unless `OBSERVATION_JOURNAL_DIR` is set on the read service; the collector runtime that supplies frozen rounds belongs to the lifecycle scheduler (#147), and no live provider source is enabled (it fails with the missing-qualification reason).

| Variable | Default | Meaning |
| --- | --- | --- |
| `OBSERVATION_JOURNAL_DIR` | unset | directory of the observation journal (`journal.jsonl`, `manifest.json`, `journal.lock`); the read service replays it read-only |
| `ARENA_APPLICATION_OBSERVATION_SCOPE` | unset | JSON `{deploymentId, network, arenaContract, protocol}` of the deployment this journal belongs to; a mismatch binds nothing |
| `OBSERVATION_QUALIFIED_MODES` | empty | comma list from `PriceGain`, `LowestDrawdown`, taken from provider qualification; market-cap and volume modes are rejected because they need exact supply or interval-trade evidence |
| `OBSERVATION_BOUNDARY_TOLERANCE_MS`, `OBSERVATION_MAX_GAP_MS` | unset | approved coverage policy, set together; without it coverage and scores stay withheld |

Route: `GET /api/arena/v1/battles/{id}/observations?deployment=&protocol=&round=&community=&after=&limit=` (limit 1 to 50). The fixture, recorded or live label comes from the samples themselves, not from configuration.

- **Capacity:** at most 200000 records or 256 MiB; nothing is pruned. Reaching it is a visible `capacity_*` error from the writer; the retention policy is an open decision.
- **Corruption:** an edited, reordered or damaged record, or a manifest ahead of the journal, makes the reader answer 503 and the writer refuse to open. Do not reset it: stop every writer, back up the directory, inspect `journal.jsonl` and `manifest.json`, restore from backup or repair the damaged tail deliberately, and only then remove an abandoned `journal.lock`.
- **Torn tail:** a crash mid-append leaves a partial last line that was never acknowledged; the next writer discards exactly those bytes and reports `torn_tail_discarded`. A manifest that lags the journal by one record is rebuilt from the journal.
- **Conflicts:** the same source evidence with different content is refused, the first record is kept and health shows `conflicting_source_evidence`.
- **Retractions:** a retraction record hides a sample without erasing it and raises `revision`; clients reload on a revision change.
- **Collector timing:** an unlocked battle is read every 15 s, except from 2 s before its start until 5 minutes after it, when it is read on every pass, so sampling starts in the pass that sees the lock and round 1's start sample (boundary tolerance 5 s) is not missed.

## Lifecycle oracle (rounds)

A dedicated process (`pnpm -C agent build && pnpm -C agent lifecycle:oracle`, issue #147) that opens and resolves recorded rounds from PERSISTED observation evidence. It holds only the dedicated oracle account key; it refuses to start when `AGENT_PRIVATE_KEY[_FILE]` or a payout relayer/operator key is in its environment. It never samples providers, never signs for custody, players or payouts, and starts in dry run.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORACLE_ACCOUNT_ID`, `ORACLE_PRIVATE_KEY` or `_FILE` | required | the arena's configured oracle account; the oracle holds (hold, not write) when the contract names another account |
| `ARENA_CONTRACT_ID`, `NEAR_NETWORK`, `NEAR_RPC_URL` | testnet | arena and network |
| `ARENA_APPLICATION_OBSERVATION_SCOPE` | required | the deployment namespace JSON (must match the arena and a lifecycle-v2 namespace of the network) |
| `OBSERVATION_JOURNAL_DIR` | required | the observation journal it reads (read-only) |
| `OBSERVATION_QUALIFIED_MODES` | empty | `PriceGain`, `LowestDrawdown` only; market-cap and volume are refused live |
| `ORACLE_EVIDENCE_KINDS` | `live` | source kinds that may resolve a round; sandbox deployments may add `fixture`/`recorded` (never on mainnet) |
| `ORACLE_TERMS_PATH` | unset | JSON `{ "<frozen policy hash>": { source, quote_currency, eligible_pools, finality, price_decimals, supply_decimals, volume_decimals, boundary_tolerance_ns, max_gap_ns } }`; a battle whose hash is absent is held |
| `ORACLE_ROUNDS_STORAGE_DEPOSIT_YOCTO` | unset | storage deposit for `start_lifecycle_rounds`; unset means the oracle never spends it and reports `needs_rounds_started` |
| `ORACLE_WRITES_ENABLED` | `false` | `true` sends transactions; otherwise it only reports what it would send |
| `ORACLE_INTERVAL_SECS`, `ORACLE_STATE_DIR` | 5, required | pass interval (1 to 20) and the directory of `status.json` and a single-process `oracle.lock` |

Behavior per pass, re-derived from the contract so a restart or a second process repeats nothing: not locked, blocked (wrong oracle, paused, not activated, no terms), needs rounds started (revealing the terms and opening round 1 in ONE transaction with two actions, which NEAR applies atomically; if that combined send fails, the battle falls back to two separate transactions), needs open (each overtime or reopened round), window open (waits for the recorded end), resolve (builds the submission from evidence, else `pending_evidence` with the reason), done. Missing, gapped or wrong-kind evidence holds pending; the clock alone never resolves a round and never moves the recorded end; there is no default winner. A failed or unconfirmed write is logged and the next pass reads the chain again. A failing battle backs off (up to 8 passes) without blocking the others. Only the newest 200 battles are scanned.

Status: `status.json` in `ORACLE_STATE_DIR` (non-authoritative, no secrets) and the `oracle` component of the application health read (set `ORACLE_STATE_DIR` and the observation scope on the read service and declare `capabilities.oracle` in the manifest). Recovery: stop the process, inspect `status.json` and the contract's round view, then restart; remove `oracle.lock` only after confirming no oracle process runs. Live round proof is not claimed: the oracle account, terms, provider qualification and a funded deployment are owner gates (#80). Qualification status today (`docs/scoring-market-data.md`, recorded 2026-11-08): no candidate token has a compliant circulating-supply source, so market-cap and volume modes cannot run; price gain and lowest drawdown need on-chain pool reads and owner decisions on provider, cadence and tolerance, so `OBSERVATION_QUALIFIED_MODES` stays empty (and the oracle holds every round `mode_unqualified`) until that record exists.

## Player agent program

Two programs exist; read [docs/player-agents.md](../docs/player-agents.md) first. `pnpm -C agent player:auto --config <file> [--live] [--once]` runs **autonomous** agents that play with their own account and balance (join, register, deposit, no approval step; every play is decided by NEAR AI Cloud, so `NEAR_AI_API_KEY` is required; dry run by default, testnet only; example config `player-autonomous.example.json`). The rest of this section describes the **grant** agent.

`pnpm -C agent player:run --config <file> [--live] [--once]` runs the player agents described in a config file (see `player-agents.example.json`). It is a separate process from the read API and the settlement loop.

- **Dry run by default.** It reads the chain, chooses a deposit with the agent's strategy, sends it through the action boundary (preview, grant check, revalidation) and prepares the delegate's `reserve` transaction, then stops. `--live` lets each agent sign its own `reserve` with the key named in its config.
- **It never moves tokens and never holds a user key.** A reservation is a budget hold. Executing a reserved deposit is an open decision (see `docs/openspec/changes/arena-player-agents/design.md`).
- **Keys** are read only from the environment variable named in each agent's `keyEnv` (for example `PLAYER_KEY_AGENT_A_TESTNET`); the config file never contains a key and errors never print one.
- **Strategies** (off chain, no authority): `crowd` backs the largest vault, `underdog` the smallest. `mode: "model"` asks NEAR AI Cloud (`NEAR_AI_API_KEY`, `NEAR_AI_MODEL`) and validates the answer like any proposal.
- **State**, no database: `PLAYER_STATE_PATH` (default `./.data/player-state.json`) and `PLAYER_ACTION_STORE_PATH` (default `./.data/player-actions.json`). The chain stays the source of truth, so losing them cannot double-spend.
- **Safety limits** per agent: `fractionBps` (default 2500), `maxPerHour` (6), `maxFailures` (3), `intervalSecs` (60), `scanBattles` (20). It skips communities where the user has no registered position, because registering needs the user's own signature.
- **Required environment:** `ARENA_CONTRACT_ID`, `PLAYER_POLICY_CONTRACT_ID`, optional `NEAR_RPC_URL`, `PLAYER_AGENTS_PATH`. Testnet only.

## Application database (Postgres / Supabase)

OpenSpec changes `hosted-agents-database` and `app-state-database`. Without any database variable every store keeps its local file, as above. Two connection strings exist, both held only by the agent services (`agent/.env.local`) and never by the web app:

- `HOSTED_AGENT_DATABASE_URL`: the hosted agent service (agents, play state, events, sessions). See [docs/player-agents.md](../docs/player-agents.md).
- `APP_DATABASE_URL`: the **action store** (read API `read:serve` and `player:run`), the **audit report archive** (the agent, the read API and `audit:report:*`), the **watchdog baselines** and the **play state** of `player:run` and `player:auto`. The matching file paths are then not used for storage. The read API's actions stay opt-in: they are enabled only when `ACTION_STORE_PATH` is set, and with `APP_DATABASE_URL` their records go to Postgres instead of that file. In `pnpm dev` the agent worker gets `APP_DATABASE_URL` from `agent/.env.local` (baselines, the audit archive and the latest audit decisions); the oracle and the collector use it only with `OBSERVATION_JOURNAL_STORE=database`.

Setup: apply `supabase/migrations/*.sql` to the project (every table has row-level security with no policy and the public roles revoked, so only the service connects), set the URL, then move existing files once with `pnpm -C agent build && pnpm -C agent app:import` (and `hosted:import` for hosted agents). Imports are idempotent, never modify the files and stop on a malformed one; audit observations keep their `seq` and timestamps.

- **Audit history is append-only in the database itself**: a trigger refuses `update`, `delete` and `truncate` on `audit_report_observations`, an existing observation id with different decision content is refused, and every row is re-validated on read (a tampered row is an error, never skipped). `PgReportArchive.forBattle(arena, battleId, community?)` reads one battle through an index.
- **Fail closed**: an unreachable database or a malformed row stops the component with an error and never resets or recreates data. Action updates are atomic per action, and the 10,000-action cap is checked in the creating transaction.
- **Latest audit decisions** (`lifecycle_audit_records`): written by the agent after the arena accepted each submission and loaded at start, so a restart does not re-audit every open battle. A cache only: every loaded row is re-checked against the asset, policy and expiry, and the arena re-checks at lock.
- **Observation journal and oracle status** (OpenSpec `observation-journal-database`, opt-in with `OBSERVATION_JOURNAL_STORE=database`, never by `APP_DATABASE_URL` alone): the collector writes `observation_journal` (one row per journal line, the same hash chain verified by the same code, append-only by trigger, one writer per namespace through a session advisory lock, acknowledged only after commit), the oracle and the read API read it incrementally (first full verified load, then only new rows), and the oracle's status goes to `lifecycle_oracle_status` under its own session lock. Set the switch for the collector, the oracle and the read API together (`pnpm dev` and `live-run.mjs` do this from `agent/.env.local`), and connect in session mode (direct or the session pooler on port 5432). Move an existing journal with `pnpm -C agent app:import-journal <journal dir>` (with `ARENA_APPLICATION_OBSERVATION_SCOPE`) after stopping the collector: it verifies the whole file, keeps sequence numbers and hashes, refuses a namespace that holds other records and is a no-op when repeated. An unreachable or corrupt database journal makes the oracle hold with `pending_evidence` and the chart answer 503, never an empty journal.
- **Not moved**: the indexer store.
- **Rollback**: unset `APP_DATABASE_URL` (and `OBSERVATION_JOURNAL_STORE`); records written since are not copied back to the files. Rounds whose evidence exists only in the database hold and later reopen; only the arena decides outcomes, so no funds move.

## Testnet faucet

The faucet is a NEAR contract (`contracts/faucet`, crate `valtrum-faucet`), not a service: nothing to host and no faucet key to protect. It gives the caller a fixed amount of each community token it holds. It never mints, so the operator stocks it (below). Players need only a NEAR testnet account and a little NEAR for gas; the web page at `/faucet` reads the contract over RPC and each claim is a transaction the player's own wallet signs.

- **Claim:** `claim(token)`. The claimer is always the caller. One claim per account and token per cooldown (24 h by default) and an optional daily budget per token that bounds what many new accounts can take. A failed transfer restores the cooldown, the budget and the record deposit.
- **Owner:** `set_token(token, symbol, amount, daily_budget)`, `remove_token`, `set_cooldown_secs`, `set_paused`, `set_owner`, `withdraw_ft`, `withdraw_near`.
- **Web:** set `NEXT_PUBLIC_FAUCET_CONTRACT_ID` in `web/.env.local`.
- **Tests:** `cargo test -p valtrum-faucet`.

### Stocking the faucet (operator)

The faucet on testnet holds 1,000,000 of each community token (100 per claim, 100,000 per day). To restock a token, register the faucet on the token contract (`storage_deposit`), transfer tokens to it with `ft_transfer`, and call `set_token(token, symbol, amount, daily_budget)` as the faucet owner.

