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
