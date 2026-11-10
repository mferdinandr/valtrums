## Context

One independently reviewed change in the arena redesign. See [coordination](../../README.md) and [product specification](../../../product-spec.md).

## Goals / Non-Goals

Deliver permissionless arena lifecycle and its acceptance scenarios without claiming unrelated work or unverified network support.

## Decisions

- Contract: [capability requirements](specs/arena-lifecycle/spec.md).
- Integration boundary: Coordinate backing deposits and audit approval.
- Late foreign deposits (owner decisions D8, D15): a foreign deposit that arrives after lock never enters the snapshot or any vault. Backing queries the arena's `get_lifecycle_battle` lock state on every claim, records a locked-battle claim as a refund-only late deposit for the beneficiary named in the claim, and the payout authority reserves the refund (`reserve_late_refund`). The arena changes nothing. D17 (refund to an EVM address bound at deposit time) is open as issue #82 and will change the refund destination, not this boundary.
- Backing approvals (`lifecycle_backing`): `refresh_lifecycle_backing` (whitelisted agent, attached deposit) calls the community representation's `get_asset` and `get_ledger` and stores an approval only when the asset equals the committed one and the ledger is balanced, not paused and not under reconciliation. Anything else withdraws the approval. The owner keeps a trust list of representation contracts (`set_lifecycle_representation_trusted`, one yocto); an untrusted one cannot be refreshed. An approval lasts 10 minutes (D2 default) and lock re-verifies the asset binding and expiry of both approvals.
- Asset identity binds source chain/token, NEAR representation and custody domain.
- The community asset identity may commit an optional mainnet reference pair (`reference_chain_id`, normalized lowercase `reference_address`; both or neither; no two communities share a pair). It is part of asset equality, so an audit approval must name the committed pair.
- Keep custody verifier, oracle, signer, operator and player authorization boundaries explicit. Fixtures do not prove live execution. DAO governance and provider/finality choices remain OPEN.

## Risks / Migration

Cross-chain operations must be idempotent, reconciled before retry and fail closed on missing evidence. Use isolated testnet deployments; legacy migration is out of scope.

## Application view/event contract (#144)

Additive ABI, preserving every old method: `get_lifecycle_battle_count_v1() -> U64`,
`get_lifecycle_battle_v1(battle_id:U64) -> Option<LifecycleView>`,
`get_lifecycle_position_v1(battle_id:U64,community:u32,account:AccountId) -> LifecyclePositionView`,
`get_lifecycle_readiness_v1(battle_id:Option<U64>) -> ApplicationReadinessV1`, and
`get_lifecycle_round_history_v1(battle_id:U64,from_round:U64,limit:u32) -> Option<RoundHistoryPageV1>`
(default supplied explicitly, limit 1..50, round IDs ordered ascending).

Readiness exposes actual exclusive activation, paused state, legacy count/activation
blocker, protocol/oracle/current policy, trusted representations and stored backing
approval asset match/expiry per requested battle. It is a read of stored evidence,
never proof of current foreign backing or authority to activate/lock.

Minimum history uses the existing stored `(round_id,outcome)` records plus additive
NEP-297 `valtrum`/`1.0.0` events: `lifecycle_round_opened_v1` binds string battle/round
IDs, candidates, start/end ns and frozen policy hash; `lifecycle_round_resolved_v1`
adds outcome, exact signed numerator/positive denominator per community and evidence
hashes; `lifecycle_round_pending_v1` records the failed-resolution reason and window.
Only successful validated resolution emits exact scores; replay of an already recorded
round emits no new resolution. The indexer durably retains these commitments in its
existing event journal with network/emitter/block/receipt/log identity. It never stores
all market samples in contract state (market persistence remains #146).

No Borsh state layout change or additional contract storage is introduced: full new
evidence is event-backed. Existing history views expose only actually stored outcomes;
missing candidates/window/scores/evidence remain null and incomplete, even for newer
records unless enriched from indexed events. Logs require source backfill/retention;
they are not a guarantee of eternal provider availability. Existing round storage/gas
funding and oracle authority remain unchanged. A fresh authorized deployment/release
is required before advertising this ABI; this issue does not deploy or upgrade it.
