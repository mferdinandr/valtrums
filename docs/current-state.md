# Current implementation snapshot

Base commit: **93eb024eb50f711662252a0e04fbcfe34610f7ca**, fetched from `origin/main` on 2026-11-06. This document describes source and previously recorded deployment evidence at that commit. It is not a new live network verification. The separate `feat/valt-token` rebase and its VALT work are outside this branch.

## Source at the base

| Area | Present behavior / evidence |
| --- | --- |
| Arena | [types](../contracts/arena/src/types.rs) hardcode sides A/B; [arena](../contracts/arena/src/lib.rs) uses a USDC proposal bond, a deposit deadline and agent approval/prices |
| Score | [math](../contracts/arena/src/math.rs) compares price performance in integer basis points; a tie voids and permits refunds |
| Deposits | Direct community token, routed USDC, internal USDC balance and seven-day credit paths exist; creator participation is not the proposed mandatory position rule |
| Settlement | Dump losing token to USDC; 55% buys liquid winner token, 35% becomes credit, 5% buys/burns winner token, 5% goes to the protocol with rounding dust |
| Principal | Winner principal is returned through the liquid balance; no target DAO principal escrow |
| Execution | Agent-reported mock mode, on-chain DEX execution and foreign EVM execution code exist |
| Foreign EVM | Chain Signatures request/relay/receipt code with fixed router and transfer constraints; no implemented Robinhood custody-backed representation or end-to-end Robinhood demo |
| Agent | [agent README](../agent/README.md): audit heuristic, price sampling/TWAP, locking, settlement and liquidity watchdog |
| Terminal | [web](../web/README.md): battle UI, portfolio, prompt parsing, deterministic transaction summary, funding adapters and function-call session keys |
| WAR | Standalone [contract](../contracts/war/src/lib.rs) is present: USDC-backed decaying war bond. The arena still has internal credit and is not wired to WAR |
| Furnace | Standalone [contract](../contracts/furnace/src/lib.rs) is present: NEP-141 sink and ledger. Arena wiring from the older proposal is not complete |
| OpenSpec | Existing [specs](openspec/specs) and `add-war-bonds` / `add-verifiable-burn` changes describe the older product; their checked tasks do not imply completion of this redesign |

The historical economics are **55/35/5/5**, seven-day credit, a USDC bond and TWAP-based price inputs. They are retained here to explain the source. The [target specification](product-spec.md) supersedes them for new arena work: no bond, no TWAP, no swap-based reward conversion or credit loop.

## Previously documented NEAR testnet deployment

The earlier deployment record identifies suffix `8875bb`: owner `valtrum-8875bb.testnet`, arena `valtrum-arena-8875bb.testnet`, router `valtrum-router-8875bb.testnet`, mock DEX `valtrum-dex-8875bb.testnet`, swap adapter `valtrum-refdex-8875bb.testnet`, and `lp.valtrum-8875bb.testnet`.

Mock USDC/PEPE/SHIB accounts are `valtrum-usdc-8875bb.testnet`, `valtrum-pepe-8875bb.testnet` and `valtrum-shib-8875bb.testnet`. Agent, treasury and burn use `agent.`, `treasury.` and `burn.` prefixes under `valtrum-8875bb.testnet`. These are historical account identifiers, not a guarantee of current configuration or availability.

The deployment began with a 5 USDC bond, 300-second deposit window and fixed-rate mock DEX. Later documentation records Ref testnet exchange `ref-finance-101.testnet`, adapter-routed PEPE/USDC pool 2899 and SHIB/USDC pool 2900. Query current configuration before using a recorded deployment.

### Recorded demos, not rerun by this PR

| Legacy demo | Recorded result |
| --- | --- |
| Mock battle 1 | 400 PEPE beats 160 SHIB; losing vault realizes 40 USDC; 22 USDC buys 22,000 PEPE, 14 USDC credit, 2 USDC burn, 2 USDC fee; 400 PEPE principal returned |
| Ref battle 6 | 160 SHIB realizes 39.832284 USDC; 21.907756 liquid-buy budget, 13.941299 credit, 1.991614 burn budget and 1.991615 fee |
| Ref winner | About 11,160.88 PEPE reward plus 400 PEPE principal, per the previous deployment record |

The four Ref budgets sum to 39.832284 USDC. Test pools and open-mint tokens demonstrate mechanics; their USD labels are fixture valuations, not real economic backing.

## Limits and evidence boundaries

- Existing liquidity/honeypot checks are heuristics, not GoPlus integration or a real sell simulation.
- TWAP history is collected locally; default 1,800 seconds. Late settlement uses a window ending at the settlement pass.
- Foreign execution exists in source, but the previous README explicitly says live signer derivation was not verified there. It assumes equal token decimals across chains and does not move assets into the derived wallet.
- Session-key method/receiver/gas restrictions are on chain, but application expiry is only client-side. A gas allowance is not a token-spending cap.
- Agent-reported execution trusts reported amounts; mock execution is not proof of custody.
- [Historical security findings](security-review.md) are a development self-review, not an audit of the target design, WAR, furnace, Robinhood assets or a new deployment.
- WAR/furnace account key removal, deployment and arena integration cannot be inferred merely from their source code.

See [deployment.md](deployment.md) for supported legacy commands and a separately labeled target rollout plan.
