## Context

One independently reviewed change in the arena redesign. See [coordination](../../README.md) and [product specification](../../../product-spec.md).

## Goals / Non-Goals

Deliver bounded player agents and its acceptance scenarios without claiming unrelated work or unverified network support.

## Decisions

- Contract: [capability requirements](specs/arena-player-agents/spec.md).
- Integration boundary: Coordinate player identity and deposit interface with lifecycle and backing.
- Asset identity binds source chain/token, NEAR representation and custody domain.
- Keep custody verifier, oracle, signer, operator and player authorization boundaries explicit. Fixtures do not prove live execution. DAO governance and provider/finality choices remain OPEN.

## Risks / Migration

Cross-chain operations must be idempotent, reconciled before retry and fail closed on missing evidence. Use isolated testnet deployments; legacy migration is out of scope.
