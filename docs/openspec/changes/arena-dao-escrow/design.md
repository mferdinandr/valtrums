## Context

One independently reviewed change in the arena redesign. See [coordination](../../README.md) and [product specification](../../../product-spec.md).

## Goals / Non-Goals

Deliver dao escrow and disposition and its acceptance scenarios without claiming unrelated work or unverified network support.

## Decisions

- Contract: [capability requirements](specs/arena-dao-escrow/spec.md).
- Integration boundary: Requires lifecycle escrow and backing reservations.
- Governance (owner decision D22, 2026-11-08; full design in [dao-governance.md](../../../dao-governance.md)): the final winning community's participants vote burn or return, weighted by their snapshotted principal, in a window that opens when the final winner is recorded and whose protocol-adjustable length is snapshotted at battle creation. No quorum and no delegation. Anyone finalizes after the window: per holder, `burn_i = floor(p_i * B / (B + R))` and `return_i = p_i - burn_i`. With no votes the principal stays escrowed. Execution uses exclusive reservations; returns use the payout path, and the burn goes to a frozen Robinhood sink address confirmed by a finalized receipt. SputnikDAO and Trezu are not used.
- Asset identity binds source chain/token, NEAR representation and custody domain.
- Keep custody verifier, oracle, signer, operator and player authorization boundaries explicit. Fixtures do not prove live execution. Provider/finality choices remain OPEN; the default window length and per-token sink address are set at deployment.

## Risks / Migration

Cross-chain operations must be idempotent, reconciled before retry and fail closed on missing evidence. Use isolated testnet deployments; legacy migration is out of scope.
