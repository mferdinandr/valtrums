## Context

One independently reviewed change in the arena redesign. See [coordination](../../README.md) and [product specification](../../../product-spec.md).

## Goals / Non-Goals

Deliver reservation-bound signing and payout and its acceptance scenarios without claiming unrelated work or unverified network support.

## Decisions

- Contract: [capability requirements](specs/arena-chain-signatures/spec.md).
- Integration boundary: Requires backing reservations and settlement entitlements.
- Asset identity binds source chain/token, NEAR representation and custody domain.
- The payout contract builds the ERC-20 transfer from the reservation, calls the signer configured at initialization and accepts a signature only from its private callback. The relayer chooses only a fee cap. Signing fees come from the contract reserve.
- Payout status is an explicit stable view (`authorized`, `signing_requested`, `signed`, `broadcast`, `pending_finality`, `reverted`, `reconciliation_required`, `confirmed`, `restored`) described in the implementation notes, with versioned NEP-297 events.
- Known gaps: only the `mock-mpc` fixture was exercised, so signer gas, `domain_id` and response shape are unverified live, and the returned signature is not verified on chain. The payout path must not be deployed or funded until that is checked.
- Keep custody verifier, oracle, signer, operator and player authorization boundaries explicit. Fixtures do not prove live execution. DAO governance and provider/finality choices remain OPEN.

## Risks / Migration

Cross-chain operations must be idempotent, reconciled before retry and fail closed on missing evidence. Use isolated testnet deployments; legacy migration is out of scope.
