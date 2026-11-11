# Current implementation snapshot

Snapshot date: **2026-11-11**, taken from `main` after PR #184. It replaces the earlier snapshot of 2026-11-06, which described the two-side arena; that history is kept at the end as an appendix. The target rules stay in the [product specification](product-spec.md); this page says what exists, what was proven on testnet, and what is still open. Where a claim is not backed by evidence under `docs/evidence/` or [testnet-evidence.md](testnet-evidence.md), it is code that is tested only with synthetic inputs.

## What exists in source

| Area | Present behavior |
| --- | --- |
| Arena contract | [arena](../contracts/arena/src/lib.rs) implements the multi-community lifecycle: creation, audit approvals, backing refresh, lock with a frozen snapshot, 30-second rounds, [scoring](../contracts/arena/src/scoring.rs) in four modes, tie handling without an overtime cap, settlement, escrow and DAO entry points, and Chain Signatures code. Agent-only methods (`submit_lifecycle_audit`, `refresh_lifecycle_backing`, `lock_lifecycle_battle`) check a whitelist managed by the owner (`add_agent`, `remove_agent`) |
| Backing and receipts | [backing](../contracts/backing) (NEP-141 representation, 1:1 with received assets, exclusive reservations) and [receipt-registry](../contracts/receipt-registry) (receipts attested by one verifier account, replay protected) |
| Payout | [payout](../contracts/payout) with separate relayer and operator roles and a signer for Robinhood transactions |
| Player policy | [player-policy](../contracts/player-policy): per-user grants with budgets, destinations and expiry; reservations are consumed by action proposals |
| Faucet | [faucet](../contracts/faucet): hands out already backed representation tokens with a cooldown and a daily budget per token. It never mints; only its owner can configure tokens, pause it or withdraw |
| Other contracts | `ref-adapter`, `router`, `war`, `furnace`, mock contracts and the sandbox integration tests. The WAR and furnace contracts are standalone and not wired to the arena |
| Agent | [agent](../agent/README.md): GoPlus and liquidity audit, custody verification, indexer, lifecycle oracle (dry run by default), observation journal and reads, payout relayer and operator roles, read API and MCP, player agent program (dry run by default), faucet funding plan generator. The earlier two-side settlement loop and TWAP code are still in the source; the lifecycle application does not use them |
| Web | [web](../web/README.md): one lifecycle application. Routes: `/` landing, `/arena`, `/arena/new`, `/arena/<id>`, `/portfolio`, `/terminal`, `/agents`, `/faucet`. Token names and logos come from fixed tables. Battles that are not locked show a display-only live price preview (not scoring evidence) |
| OpenSpec | Thirteen changes and one spec in [OpenSpec](openspec/README.md), validated strictly by the local pre-commit script |

## What is on testnet (2026-11-11)

Accounts and contracts are listed in [deployment.md](deployment.md); recorded observations are in [testnet-evidence.md](testnet-evidence.md).

| Item | State |
| --- | --- |
| Arena, registry, payout, six backings, current player policy (`policy-v2`) | Deployed and wired on 2026-11-09 |
| Infrastructure agent in the arena whitelist | Registered with `add_agent` (transaction in [testnet-evidence.md](testnet-evidence.md), section 8) |
| Battle 1 | Created with six communities (CASHCAT, WALLET, GOOD, AI, VLAD, DEGEN). Not locked |
| Robinhood testnet custody deposits | A first set of six deposits could not be verified (finalized head moved too far). A second set of six was verified and attested, receipts claimed and 1,000,000 of each representation minted ([testnet-evidence.md](testnet-evidence.md), section 9) |
| Audit | A read-only dry run of the production audit pass gave `pass` for five communities and `pending` for AI (no v3 WETH pool, so no liquidity evidence). Nothing was submitted, so no community has an audit approval on chain |
| Faucet contract | Stocked: 1,000,000 of each of the six tokens, 100 per claim, 100,000 per day, 24 hour cooldown. No user claim has been made yet |
| Rounds, observations, settlement, payout | Never run on testnet |

## Known gaps

- **No playable battle yet.** Deposits are refused until every community has an audit approval and a backing approval. Locking also needs fresh approvals for all communities, so battle 1 cannot lock while AI is Pending.
- **Round observations.** The contract stores outcomes, not per-second samples. The chart of locked battles shows only persisted observations, and no live provider source is enabled. The oracle account of the deployed arena is not confirmed set. The deployed arena also lacks the `_v1` read views, which affects display only.
- **Payout is unproven.** The terminal blocks payout until spendable custody (#148) is proven and the contract exposes an entitlement. Winners are paid original tokens on Robinhood by design; that path has not run.
- **DAO disposition of winning principal** is an open decision (see the findings log).
- **Player agents** run in dry run; no live proposal has been sent on testnet.
- **Intents funding** uses a labeled fixture, not NEAR Intents.
- **End-to-end demo with failure recovery** (issue #80) is not done. Issues #149 (connected deposit UX) and #151 (portfolio and payout) are open.
- **Reachability.** The Robinhood RPC hosts may be blocked or have an expired certificate on some networks. Local runs used a DNS-over-HTTPS relay; set `PRICE_PREVIEW_RPC_URL` and `REFERENCE_RPC_URL` to a reachable RPC.
- [Historical security findings](security-review.md) are a development self-review, not an audit of the target design, WAR, furnace, Robinhood assets or a deployment.

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
