# Current implementation snapshot

Snapshot date: **2026-11-14**. It replaces the earlier snapshots of 2026-11-06 (the two-side arena, kept at the end as an appendix) and 2026-11-11. The target rules stay in the [product specification](product-spec.md); this page says what exists, what runs on testnet, and what is still open. Where a claim is not backed by evidence under `docs/evidence/` or [testnet-evidence.md](testnet-evidence.md), it is code that is tested only with synthetic inputs.

**Scope.** Valtrums runs on **NEAR testnet only**. Deposits, the faucet, settlement, claims and the winners' vote all happen on NEAR. Robinhood Chain **mainnet** (4663) is only read: its Uniswap v3 pools give round prices and liquidity, and GoPlus gives token-risk data. Nothing is sent to Robinhood Chain. The earlier Robinhood Chain testnet custody path (EVM contracts, custody deposits, payouts through Chain Signatures) is retired; the `evm/` folder was deleted.

## What exists in source

| Area | Present behavior |
| --- | --- |
| Arena contract | [arena](../contracts/arena/src/lib.rs) implements the multi-community lifecycle: creation, audit approvals, backing refresh, lock with a frozen snapshot, 30-second rounds, [scoring](../contracts/arena/src/scoring.rs) in four modes, tie handling without an overtime cap, settlement, escrow, refunds and the winners' vote. Agent-only methods (`submit_lifecycle_audit`, `refresh_lifecycle_backing`, `lock_lifecycle_battle`) check a whitelist managed by the owner (`add_agent`, `remove_agent`) |
| Community tokens | [backing](../contracts/backing): one NEP-141 contract per community token with a ledger of live supply, entitlements, DAO escrow and burns that must balance. Settlement turns losing deposits into entitlements, which winners claim into their NEAR wallet (`claim_entitlement_as_representation`); the burned share of a winning principal is destroyed on NEAR |
| Player policy | [player-policy](../contracts/player-policy): per-user grants with budgets, destinations and expiry; reservations are consumed by action proposals |
| Faucet | [faucet](../contracts/faucet): hands out the community tokens it holds with a cooldown and a daily budget per token. It never mints; only its owner can configure tokens, pause it or withdraw |
| Other contracts | `ref-adapter`, `router`, `war`, `furnace`, `receipt-registry`, `payout`, mock contracts and the sandbox integration tests. They are earlier work and not part of the player flow |
| Agent | [agent](../agent/README.md): GoPlus and liquidity audit, lifecycle oracle, observation collector and journal, read API and MCP, player agent programs (self-run and hosted), faucet tooling. The earlier two-side settlement loop and TWAP code are still in the source; the lifecycle application does not use them |
| Web | [web](../web/README.md): one lifecycle application. Routes: `/` landing, `/arena`, `/arena/new`, `/arena/<id>`, `/portfolio`, `/terminal`, `/agents`, `/faucet`. Token names and logos come from fixed tables. Battles that are not locked show a display-only live price preview (not scoring evidence) |
| User docs | [docs-site](../docs-site/README.md): Next.js docs at docs.valtrums.xyz |
| OpenSpec | Changes and specs in [OpenSpec](openspec/README.md), validated strictly by the local pre-commit script |

## What runs on testnet (2026-11-14)

Accounts and contracts are listed in [deployment.md](deployment.md); recorded observations are in [testnet-evidence.md](testnet-evidence.md).

| Item | State |
| --- | --- |
| Arena, six community tokens, current player policy (`policy-v2`), faucet | Deployed and wired |
| Open arena | Create, join, deposit, audit and backing approval, lock, 30-second rounds scored from on-chain prices, recorded winner, settlement into entitlements, escrow, and a cancel-and-refund drill all ran live (see [handoff](handoff-live-run.md)) |
| Winners' vote | Votes and burns ran live; burned shares left the token supply on NEAR |
| Faucet | Stocked with 1,000,000 of each token, 100 per claim, 100,000 per day, 24 hour cooldown |
| Player agents | An autonomous NEAR AI agent played a live battle on 2026-11-11 (battle 30: NEAR AI chose, the agent joined and deposited 7.5 WALLET) |

## Known gaps

- **Round observations.** The contract stores outcomes, not per-second samples. The chart of locked battles shows only persisted observations. Only the Price % Gain mode has a qualified live observation source today.
- **Player agents.** Grant agents can only reserve budget and cannot execute a deposit. A recorded run with several independently funded agents is still to be added. Self-run agents don't claim their winnings; hosted agents do. See [player-agents.md](player-agents.md).
- **End-to-end demo with failure recovery** (issue #80) is not done.
- **Reachability.** The Robinhood mainnet RPC hosts may be blocked on some networks. Set `PRICE_PREVIEW_RPC_URL` and `REFERENCE_RPC_URL` to a reachable RPC.
- [Historical security findings](security-review.md) are a development self-review, not an audit of the target design, WAR, furnace or a deployment.

See [deployment.md](deployment.md) for accounts and the rollout plan and [implementation-tracker.md](implementation-tracker.md) for progress against the checklist.

## Appendix: earlier two-side arena (2026-11-06 snapshot, historical)

The base commit of that snapshot was **93eb024eb50f711662252a0e04fbcfe34610f7ca**. At that point the arena hardcoded sides A and B with a USDC proposal bond, a deposit deadline, TWAP-based price inputs, swap settlement (55% liquid buy, 35% seven-day credit, 5% burn, 5% protocol) and an internal credit balance. None of this is the target; the rules in [product-spec.md](product-spec.md) replace it.

The earlier deployment record identifies suffix `8875bb`: owner `valtrum-8875bb.testnet`, arena `valtrum-arena-8875bb.testnet`, router `valtrum-router-8875bb.testnet`, mock DEX `valtrum-dex-8875bb.testnet`, swap adapter `valtrum-refdex-8875bb.testnet`, and `lp.valtrum-8875bb.testnet`. Mock USDC/PEPE/SHIB accounts are `valtrum-usdc-8875bb.testnet`, `valtrum-pepe-8875bb.testnet` and `valtrum-shib-8875bb.testnet`. These are historical account identifiers, not a guarantee of current configuration or availability.

Recorded demos of that system, not rerun:

| Legacy demo | Recorded result |
| --- | --- |
| Mock battle 1 | 400 PEPE beats 160 SHIB; losing vault realizes 40 USDC; 22 USDC buys 22,000 PEPE, 14 USDC credit, 2 USDC burn, 2 USDC fee; 400 PEPE principal returned |
| Ref battle 6 | 160 SHIB realizes 39.832284 USDC; 21.907756 liquid-buy budget, 13.941299 credit, 1.991614 burn budget and 1.991615 fee |
| Ref winner | About 11,160.88 PEPE reward plus 400 PEPE principal, per the previous deployment record |

Test pools and open-mint tokens demonstrate mechanics; their USD labels are fixture valuations, not real economic backing.
