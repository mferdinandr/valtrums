## Context

One independently reviewed change in the arena redesign. See [coordination](../../README.md) and [product specification](../../../product-spec.md).

## Goals / Non-Goals

Deliver dao escrow and disposition and its acceptance scenarios without claiming unrelated work or unverified network support.

## Decisions

- Contract: [capability requirements](specs/arena-dao-escrow/spec.md).
- Integration boundary: Requires lifecycle escrow and backing reservations.
- Governance (owner decision D22, 2026-11-08; full design in [dao-governance.md](../../../dao-governance.md)): the final winning community's participants vote burn or return, weighted by their snapshotted principal, in a window that opens when the final winner is recorded and whose protocol-adjustable length is snapshotted at battle creation. No quorum and no delegation. Anyone finalizes after the window: per holder, `burn_i = floor(p_i * B / (B + R))` and `return_i = p_i - burn_i`. With no votes the principal stays escrowed. Execution uses exclusive reservations; returns use the payout path, and the burn goes to a frozen Robinhood sink address confirmed by a finalized receipt. SputnikDAO and Trezu are not used.
- Asset identity binds source chain/token, NEAR representation and custody domain.
- Escrow reservation (#73). The backing ledger has an exclusive `escrow` bucket (`B = M + E + P + D + U + X`). After the final winner is recorded, anyone calls arena `reserve_lifecycle_escrow(battle_id)` with a 10 mNEAR storage deposit; the arena calls backing `reserve_principal_escrow(escrow_id, battle_id, community, amount)` on the winning representation. Only the configured arena may call it; it burns the arena's locked representations and moves the same units from `minted` to `escrow`, idempotent per `escrow_id = sha256("valtrum/escrow/v1" ‖ arena ‖ battle ‖ community)`. The callback records `reserved` only on a boolean answer, so a failure can be retried. Units leave `escrow` only through the D22 execution below. Losing-token settlement never waits for the escrow.
- Decision-bound execution (#75, D24).
  - **Arena:**
    - The window is 1 minute to 30 days, set by the protocol account, snapshotted at creation, and opens at the winner's block time.
    - Votes are final and weighted by the frozen position. Only participants of the winning community vote.
    - `execute_lifecycle_disposition` is permissionless after the window and needs the escrow reserved.
    - It builds a fixed plan (each winner's return portion in first-deposit order, then one burn). Each release id is `sha256("valtrum/dao-release/v1" ‖ arena ‖ battle ‖ index)`, and the plan fails closed if positions do not add up to the escrow.
    - Releases are sent in batches of at most 10, with a cursor like settlement's.
  - **Backing:**
    - `release_escrow_return` moves escrow to the winner's entitlement.
    - `release_escrow_burn` moves escrow to `disposal` as a `Disposal` reservation, held by the arena under the release id, with the sink as destination.
    - Both are arena-only and idempotent, and their total is bounded by the escrow.
    - The sink is set once by the backing owner.
  - **Payout:** `request_dao_burn` (permissionless) asks the backing for the existing burn reservation (`reserve_dao_burn`, payout authority only, destination must equal the sink) and follows the normal signing path.
  - **Confirmation:** `confirm_payout` consumes it only with a finalized debit to the sink, then counts it as `burn_confirmed`. `release_payout` refuses `Disposal`, so a failed burn is retried, never released. Deployments are fresh: the ledger and arena state layouts change without migration.
- Protocol authority under a SputnikDAO (#113, D28; [sputnik-authority.md](../../../sputnik-authority.md)). The vote above is unchanged. A council of 2 to 3 team accounts (simple majority, members added by proposal) becomes the arena protocol account (`set_lifecycle_dao_window`, `set_lifecycle_fee`, protocol fee recipient) and the backing owner (`set_dao_sink`, once per token), through one-yocto `FunctionCall` proposals. Payout operator, relayer, agent, scheduler and the deploy key stay outside the DAO. The DAO has no method to submit or override a decision or move escrowed principal (backing release methods accept the arena only). Owner decisions (D33): the reference-token registry methods now require the protocol account (code change), the DAO is the backing owner from initialisation (pausing needs a council vote, the DAO appoints the custody operator), and the protocol fee stays an entitlement to the DAO's NEAR account (EVM withdrawal is a known gap). Verified in the sandbox with the official SputnikDAO 3.31 wasm; not deployed (no testnet accounts yet).
- Keep custody verifier, oracle, signer, operator and player authorization boundaries explicit. Fixtures do not prove live execution. Provider/finality choices remain OPEN; the default window length and per-token sink address are set at deployment.

## Risks / Migration

Cross-chain operations must be idempotent, reconciled before retry and fail closed on missing evidence. Use isolated testnet deployments; legacy migration is out of scope.
