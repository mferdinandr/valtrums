## Context

One independently reviewed change in the arena redesign. See [coordination](../../README.md) and [product specification](../../../product-spec.md).

## Goals / Non-Goals

Deliver permissionless arena lifecycle and its acceptance scenarios without claiming unrelated work or unverified network support.

## Decisions

- Contract: [capability requirements](specs/arena-lifecycle/spec.md).
- Integration boundary: Coordinate backing deposits and audit approval.
- Late foreign deposits (owner decision): a foreign deposit that arrives after lock never enters the snapshot or any vault. Backing records it as unattributed and returns it to the original depositor after finality. The refund path belongs to the arena-asset-representation (backing) change and is not implemented in this change.
- Asset identity binds source chain/token, NEAR representation and custody domain.
- The community asset identity may commit an optional mainnet reference pair (`reference_chain_id`, normalized lowercase `reference_address`; both or neither; no two communities share a pair). It is part of asset equality, so an audit approval must name the committed pair.
- Keep custody verifier, oracle, signer, operator and player authorization boundaries explicit. Fixtures do not prove live execution. DAO governance and provider/finality choices remain OPEN.

## Risks / Migration

Cross-chain operations must be idempotent, reconciled before retry and fail closed on missing evidence. Use isolated testnet deployments; legacy migration is out of scope.
