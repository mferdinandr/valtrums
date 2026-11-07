## Context

One independently reviewed change in the arena redesign. See [coordination](../../README.md) and [product specification](../../../product-spec.md).

## Goals / Non-Goals

Deliver reservation-bound signing and payout and its acceptance scenarios without claiming unrelated work or unverified network support.

## Decisions

- Contract: [capability requirements](specs/arena-chain-signatures/spec.md).
- Integration boundary: Requires backing reservations and settlement entitlements.
- Asset identity binds source chain/token, NEAR representation and custody domain.
- Known gap: the current payout contract makes no MPC signer call and builds no transaction; a relayer obtains the authorized payload and reports the signature. Until the contract calls the signer itself, the payout path must not be deployed or funded.
- Keep custody verifier, oracle, signer, operator and player authorization boundaries explicit. Fixtures do not prove live execution. DAO governance and provider/finality choices remain OPEN.

## Risks / Migration

Cross-chain operations must be idempotent, reconciled before retry and fail closed on missing evidence. Use isolated testnet deployments; legacy migration is out of scope.
