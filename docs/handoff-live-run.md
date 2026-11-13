# Handoff: open arena live on testnet (2026-11-11, about 15:40 UTC)

> **Note (2026-11-14):** The Robinhood Chain testnet custody, the EVM contracts and payouts to Robinhood are retired. Valtrums now runs on NEAR only; Robinhood Chain mainnet is only read for prices and token audits. Anything below about custody, payouts or Chain Signatures is historical. See [current state](current-state.md).

Read this first. It replaces the "What is NOT done" list of [handoff-open-arena.md](handoff-open-arena.md), which is now history. Deadline: **2026-11-14 23:59 UTC**.

Rules that still apply: every chain action needs the owner's explicit approval for that action alone (show the dry run or exact call first); never push to `main` (branch, PR, merge after the owner approves); small English commits without AI attribution; run `scripts/pre-commit.sh` before a push; keys live only in the git-ignored `.env` and are never printed or passed on a command line. See [CLAUDE.md](../CLAUDE.md).

## 1. Where things stand

The open arena works end to end on testnet up to settlement and escrow: create with a start time, join with an allowlisted token, deposit, audit and backing by the agent, lock at the start, 30-second rounds scored from real on-chain prices, a round recovered with `reopen_lifecycle_round`, a recorded winner, settlement into entitlements, winning principal into DAO escrow, and a cancel-and-refund drill.

Evidence: [evidence/2026-11-11-open-arena-rollout.json](evidence/2026-11-11-open-arena-rollout.json), [evidence/2026-11-11-open-arena-live-run.json](evidence/2026-11-11-open-arena-live-run.json), [testnet-evidence.md](testnet-evidence.md) section 10.

### Merged on `main` (PRs #185 to #198)

| Area | What |
| --- | --- |
| Contract | Open arena (#185), `reopen_lifecycle_round` (#190), per-mode observation policy D40 (#197) |
| Agent | Open arena actions and lock (#186), on-chain `slot0` observation source, collector process, oracle reopen and deposit-unit fix (#191), indexer for the round reopened event (#194), collector RPC load fix (#196) |
| Web | Open arena create, join, cancel, refund and terminal intents (#188), e2e and fixture label (#193), only the five joinable assets, AI hidden everywhere (#198) |
| Docs | Decisions D34 to D40 (#187, #197), rollout runbook and script (#189), evidence (#192, #195) |

### Testnet facts

| Item | Value |
| --- | --- |
| Arena | `arena.valtrum-owner-b694.testnet`. Deployed wasm: the #190 build (sha256 `0469d249...10ad`). **D40 (#197) is merged but NOT deployed.** |
| Oracle | `valtrum-oracle-b694.testnet` (permanent, set with `set_lifecycle_oracle`); key in `.env` as `TESTNET_ORACLE_*` |
| Observation policy | legacy single policy, version 1, hash `3d54cbd5a4421eb7f1a09ef8cc249c5be7d525e52bd9f805bf17e9c7085d9dee` = PriceGain over [open-arena-observation-terms.draft.json](openspec/changes/arena-testnet-integrations/open-arena-observation-terms.draft.json) |
| Joinable allowlist | CASHCAT, WALLET, GOOD, VLAD, DEGEN (DAO proposals 17 to 21). AI is not joinable and its backing is untrusted |
| Arena storage registration | registered on all five joinable backings (needed for deposits, runbook step 6b) |
| DAO vote window | 30 seconds (set by an earlier DAO proposal); the owner chose to keep it |
| Accounts with keys in `.env` | `OWNER`, `COUNCIL1..3`, `AGENT`, `ORACLE`, `USER1`, `USER2`, ... (`TESTNET_<ROLE>_ACCOUNT_ID` / `_PRIVATE_KEY`) |
| Balances to watch | the owner had only about 0.3 NEAR (top up from a council account before owner calls); council1 about 3 NEAR after funding; user1, user2, agent about 2 NEAR each |

### Battles

| # | State | Notes |
| --- | --- | --- |
| 1 | open, old rules (no start time), all vaults 0 | abandoned; can never be cancelled |
| 2 | **decided**: CASHCAT beat WALLET | settled (user1 49.975 WALLET, DAO 0.025 WALLET entitlements on `backing-wallet`); escrow reserved (50 CASHCAT); the 30 s DAO window closed without votes, so the principal stays escrowed by design (D22) |
| 3 | cancelled, refunded | the cancel-and-refund drill |
| 4 | **funded, not locked yet** at 15:39 UTC | user1 20 CASHCAT (community 0), user2 20 WALLET (community 1), start 15:24:38 UTC. The agent could not finish a pass because every public NEAR testnet RPC answered HTTP 429 to our IP |

## 2. What is left, in order

### 2.1 Finish battle 4 (needs a working RPC)

The live processes were running on the previous machine; they do not run on yours. To continue:

1. Get a NEAR RPC that is not rate-limited. A FastNEAR API key was added to `.env` as `FASTNEAR_API_KEY`, but FastNEAR answered `403 Invalid API key` on testnet and mainnet (format checked: `https://test.rpc.fastnear.com?apiKey=<key>`). Check the key in the FastNEAR dashboard. With a valid key the scripts below use it automatically.
2. `pnpm install && pnpm -C agent build`.
3. Relay for the reference prices: `python3 scripts/rpc-relay.py 18546 rpc.mainnet.chain.robinhood.com`.
4. With the owner's approval (the agent and the oracle send transactions): `node scripts/testnet-wiring/live-run.mjs` (agent, oracle, collector; logs and state in `.live-state/`). Override RPCs per process with `AGENT_RPC_URL`, `ORACLE_RPC_URL`, `COLLECTOR_RPC_URL` if needed.
5. With the owner's approval of the vote: `node scripts/testnet-wiring/dao-watch.mjs 4 0=USER1 1=USER2` votes "return" inside the 30 s window for the winner's depositor, reserves the escrow and executes the disposition.

Expect: the agent re-audits both communities (approvals last 10 minutes), locks, the oracle starts rounds and opens round 1, the collector samples every second, the oracle submits after the window. Thin tokens often tie (both prices move with ETH), which leads to more 30 s rounds; that is the rules, not a bug. If a window misses its start sample, the oracle reopens it after 130 s.

Note: the journal of battle 2 lives in the previous machine's scratch directory, not in `.live-state/`; it is not needed again (battle 2 is decided).

### 2.2 Activate D40 on testnet (2 chain actions, owner approval)

1. Redeploy the arena from `main` (state kept; `cd contracts/arena && cargo near build non-reproducible-wasm`, then sign the deploy as the arena account with the owner's deploy key; see `deploy-arena` in [open-arena.mjs](../scripts/testnet-wiring/open-arena.mjs), which already does this). The arena may need a small NEAR top-up for the larger code (last time `LackBalanceForState`, fixed with 0.5 NEAR from council3).
2. Owner: `set_lifecycle_mode_observation_policy {mode: "PriceGain", policy: {version: "1", policy_hash: "3d54cbd5...9dee"}}` with one yocto. After this only PriceGain battles can be created, matching the web's `NEXT_PUBLIC_LIFECYCLE_CREATE_MODES`.

Do this when no battle is between lock and resolution.

### 2.3 Payout live proof (never run)

User1 holds a real 49.975 WALLET entitlement on `backing-wallet` from battle 2. Path: `payout.request_payout` (user1, 0.03 NEAR) → payout relayer requests the MPC signature (`pnpm -C agent payout:relayer`) → the signed transfer is broadcast from the custody holder `0x0b74...0c41` on Robinhood testnet → after finality (about an hour) the operator confirms (`pnpm -C agent payout:operator`). Read [live-custody-proof-plan.md](openspec/changes/arena-testnet-integrations/live-custody-proof-plan.md) first (it describes the late-refund path; the entitlement path is shorter now). Every step is a chain action on NEAR or Robinhood testnet and needs approval. Stop conditions are in that plan.

### 2.4 Smaller items

- The OpenSpec web and terminal tasks for the open arena are unchecked until the owner checks the UI by hand.
- The web e2e suite was last run at 20 of 25 passing before its final fixes (#193); rerun `pnpm -C web e2e` once.
- `agent/.vitest/json/output.json` and `web/.vitest/json/output.json` are tracked and change on every test run; restore them before committing (`git checkout -- <file>`), or untrack them in a small PR.

## 3. Known risks and lessons from the live runs

- **RPC rate limits** are the main operational risk: agent, oracle and collector each read NEAR state often. Give each its own RPC endpoint or use a keyed provider. Symptom: `HTTP 429` in the logs, no lock at the start time.
- **Boundary samples**: if the collector learns of a window late, the start sample misses the 5 s tolerance and the round cannot resolve. The collector now samples from the lock onward, and the oracle reopens a window after 130 s.
- **A funded community whose approval lapses** blocks the lock (and a battle with two funded communities cannot be cancelled) until the agent refreshes it. Keep the agent running from before the start until the lock.
- **The DAO window is 30 s**: a vote needs the watcher script; nobody can vote by hand in time.
- **Prices**: Uniswap v3 `slot0` at the latest (unfinalized) Robinhood block through the relay (D39). Thin tokens tie often.
- A process that receives a stop signal may log `loop stopped` and stay alive doing nothing; restart it.
- Storage registration: any new joinable token needs `storage_deposit` for the arena on its backing before deposits work.

## 4. Prompt to give your Claude

> Continue the Valtrum open-arena work. Read `docs/handoff-live-run.md` first, then `CLAUDE.md`. Everything up to PR #198 is merged on `main`. Next, in this order and with my approval for every chain action: (1) finish live battle 4 once a working NEAR RPC is available; (2) activate D40 on testnet (redeploy and set the PriceGain mode policy); (3) the payout live proof for user1's WALLET entitlement. Show me the plan before changing anything.
