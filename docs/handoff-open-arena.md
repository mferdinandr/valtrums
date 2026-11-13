# Handoff: open arena (2026-11-11)

> **Note (2026-11-14):** The Robinhood Chain testnet custody, the EVM contracts and payouts to Robinhood are retired. Valtrums now runs on NEAR only; Robinhood Chain mainnet is only read for prices and token audits. Anything below about custody, payouts or Chain Signatures is historical. See [current state](current-state.md).

Read this first, then `docs/openspec/changes/arena-lifecycle/open-arena-contract-notes.md` and `open-arena-agent-notes.md`. The approved plan the work follows is summarised below.

## The product change

The arena changes from invite-only to open:

- The creator creates an arena and sets its START TIME (the war starts then, 30-second rounds). The creator must take part (positive deposit before start).
- Communities are not chosen at creation. A token counts as "entered" only when it is deposited; joining adds the community automatically (before start).
- At the start time there must be at least 2 funded communities. Otherwise anyone can cancel and each depositor claims a refund.
- Only protocol-registered tokens may join (allowlist). Decided: the five tokens that pass audit policy v1 (CASHCAT, WALLET, GOOD, VLAD, DEGEN). AI (Affair Inu) is excluded (audit Pending, look-alike risk); it can be added later by a DAO proposal.
- Owner decisions behind this (to be written as D34 to D38 in `docs/findings-and-decisions.md`, not done yet): D34 open arena model and start time; D35 allowlist of five tokens, AI excluded; D36 cancel and refund below 2 funded communities; D37 deposit gate relaxed to the target community, lock needs fresh approvals for every FUNDED community, empty communities are excluded at lock; D38 fee and creator share unchanged for late communities (agent choice, confirm).

## Branches (stacked, all pushed to origin, no PR yet)

1. `feat/open-arena-contract` (from main `32a96ae`): 5 commits. The first commit does not build alone (it needs the second); squash before merging if you want a clean history.
2. `feat/open-arena-agent` (on top of 1): 5 commits plus this file.

Open the PRs in that order, merge the contract first, then rebase or merge main into the agent branch and re-run the checks (GitHub Actions CI is off).

## Done and verified locally

- Contract: `cargo test -p valtrum-arena` 435 passed; integration `lifecycle_open_arena` 4, `sputnik_authority` 2, `lifecycle_creation` 2 passed; clippy clean. State compatibility is proven by a sandbox test that deploys the previous main wasm, creates a battle and a position, then deploys the new wasm over the same account (no borsh layout change; new state lives in standalone maps with new `StorageKey` variants at the end of the enum).
- Agent: typecheck clean; `pnpm -C agent test` 971 passed and 2 failed. The 2 failures (`test/faucet/funding-plan.test.ts`) exist on main too: the checkout path contains spaces and the test builds a URL with `%20`. Not caused by this work.
- OpenSpec validate: 11 passed and 3 failed on both main and these branches (`arena-market-observations`, `arena-mcp-terminal`, `arena-testnet-integrations`, warnings in specs we did not touch).

## What is NOT done (in this order)

1. Decisions and specs (P0): write D34 to D38, update OpenSpec arena-lifecycle (new requirements and scenarios: create with a start time, join by deposit, funded-only lock, deposits closed at start, cancel and refund, no add after lock), arena-lifecycle-frontend, arena-audit, arena-asset-representation, arena-mcp-terminal, arena-settlement, arena-scoring, arena-testnet-integrations, product-spec, battle-rules, interfaces, security-review, CLAUDE.md lines 3 and 25. Keep requirement text under 500 characters.
2. Web (P3), code only; the owner checks the UI by hand and nobody runs the web app on his behalf: create form with a start time (no invited communities), join-by-token then deposit, countdown to start, entered versus pending communities, cancelled state with a refund button, cancel button when allowed, terminal intents. The contract and agent interfaces are in the two notes files. Known spots: `web/src/lib/arena-read/create-review.ts` (MIN 2 and MAX 16, copy), `components/lifecycle-create-review.tsx`, `lib/arena-read/deposit-flow.ts`, `components/lifecycle-participate.tsx`, `lifecycle-battle-detail.tsx`, `lib/terminal/lifecycle-intent.ts` and parsers.
3. Testnet rollout (P4): every chain action needs the owner's approval one by one. (a) redeploy the arena code in place on `arena.valtrum-owner-b694.testnet` with the owner key (state is kept; battle #1 stays on the old rules and is abandoned); (b) five DAO proposals (council 2 of 3) calling `set_lifecycle_joinable_asset` for CASHCAT, WALLET, GOOD, VLAD, DEGEN with the asset identities of their six backings; (c) remove AI's backing from the trusted-representation list; (d) create the oracle account `valtrum-oracle-b694.testnet` (faucet), call `set_lifecycle_oracle` ONCE (permanent), and `set_lifecycle_observation_policy`; (e) run the observation collector and oracle worker; (f) live run: create an arena with a start time, deposits from user1 and user2 with faucet tokens, audit, lock at start, 30-second rounds, and a cancel-and-refund drill.
4. Missing runtime pieces: no process runs the observation collector (`agent/src/observations/collector.ts` is code only) and the oracle account does not exist; without both no round can run. Payout live proof (an MPC-signed token transfer from the derived address) has never been run on testnet (`docs/openspec/changes/arena-testnet-integrations/live-custody-proof-plan.md`).

## Decisions and risks to know

- `AUDIT_BACKING_REFRESH_ENABLED` defaults to on when audit is on: the agent account spends about 0.01 NEAR per refresh call (mostly refunded). The owner has not confirmed this default.
- A funded community whose audit or backing later lapses blocks the lock, and with 2 or more funded communities nobody can cancel; the agent refreshes backing about 3 minutes before it expires.
- A battle created without a start time keeps the old behaviour and can never be cancelled or refunded.
- Registered but unfunded positions leave small orphaned storage after a cancel.
- The three contract events `lifecycle_refund_failed`, `lifecycle_joinable_asset_set` and `lifecycle_joinable_asset_removed` are now modelled by the indexer (update 2026-11-11), so the allowlist proposals keep it healthy.
- Storage-deposit and gas constants in the agent actions are estimates; verify them in the live run.

## Rules of this project

- Never push to `main`; one issue or topic = one branch = one PR; small English commits without AI attribution; merge only with the owner's approval; GitHub Actions CI is off, so run the checks locally before every merge (`cargo test`, `pnpm -C agent test`, `pnpm typecheck`, OpenSpec validate).
- Do not decide funds, security or economics questions: ask the owner.
- Testnet keys live only in the owner's git-ignored `.env` (`TESTNET_<ROLE>_ACCOUNT_ID` and `TESTNET_<ROLE>_PRIVATE_KEY`); never print, log or commit a key, and never pass one as a command-line argument. Public ids are in `docs/evidence/` and `docs/testnet-evidence.md`.
- Testnet facts: arena `arena.valtrum-owner-b694.testnet` (DAO `valtrum-protocol.sputnikv2.testnet` is the protocol account; deploy key stays with the owner account), payout `payout.valtrum-owner-b694.testnet`, six backings `backing-<symbol>.valtrum-owner-b694.testnet`, faucet `valtrum-faucet.testnet`, Robinhood testnet forwarder `0xEb49d8E71A5B2f5B4fA9Da33C3b1838e249F5C6C`, deadline 2026-11-14 23:59 UTC.

## Prompt to give your Claude

> Continue the Valtrum open-arena work. Read `docs/handoff-open-arena.md` on branch `feat/open-arena-agent` first, then Code/CLAUDE.md. Branches `feat/open-arena-contract` and `feat/open-arena-agent` are pushed and stacked. Next, in this order: (1) write decisions D34 to D38 and the OpenSpec and doc updates; (2) the web changes (code only, never run the web app); (3) open the PRs (contract first) and verify locally; (4) the testnet rollout with the owner's approval for every chain action. Show me the plan before changing anything.
