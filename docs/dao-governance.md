# DAO governance of winning principal

Design for issue [#74](https://github.com/mferdinandr/valtrum/issues/74), decided by the owner on 2026-11-08 (decision D22 in the [decision log](findings-and-decisions.md)). It resolves OQ-DAO in the [product specification](product-spec.md). The owner approved this design on 2026-11-08 (PR [#99](https://github.com/mferdinandr/valtrum/pull/99)). It is implemented ([#75](https://github.com/mferdinandr/valtrum/issues/75)) and has run live on testnet. Everything happens on NEAR.

## What is being decided

Battle rounds last 30 seconds and only decide the winner. After the final winner exists:

- Participants on the winning community receive the losing tokens immediately. That does **not** depend on this vote.
- The winning community's **own deposits (the winning principal)** stay locked in DAO escrow. The vote decides what happens to them: **burn** (destroy on NEAR) or **return** (give back to their owners).

## Owner decisions

| Topic | Decision |
| --- | --- |
| Membership | Per battle: the registered participants of the final winning community, as frozen in the battle snapshot. Losing and eliminated communities do not vote. The creator votes only if they are a participant of the winning community. |
| Voting weight | Each voter's escrowed principal in that battle (their snapshotted position amount). |
| Decision | A pro-rata split. Each voter sets a burn percentage `p` (0 to 100) and the rest is returned automatically. Their weight `w` adds `w * p` to the burn side `B` and `w * (100 - p)` to the return side `R`. The burn share is `B / (B + R)`, the weighted average of the votes cast (D43). |
| Non-voters | The split applies to the **whole** escrow, so non-voters follow the voters. |
| Quorum | None. |
| Window | Opens when the final winner is recorded. Its length is a protocol-adjustable parameter. |
| Fallback | If no vote at all is cast in the window (`B + R = 0`), the principal **stays escrowed**. There is no timeout, automatic return or automatic burn. |
| Delegation | None in v1. Only the participant's own account votes, and a player agent cannot vote unless a later grant design explicitly allows it. |
| Execution | The arena contract tallies the votes itself. After the window closes, **anyone** can trigger finalization and execution. No owner, worker, multisig or external DAO can create, change or veto a decision. |
| Burn method | The burn portion is destroyed on NEAR: it leaves the token's supply and is never minted again. |
| SputnikDAO, Trezu | Not used for the winners' vote, which the arena contract tallies (D22). Since D28 (2026-11-09) a SputnikDAO on testnet (`valtrum-protocol.sputnikv2.testnet`) owns protocol-level authority and receive the protocol fee ([#113](https://github.com/mferdinandr/valtrum/issues/113)); it cannot change or veto a battle's tally. Trezu is only an optional interface to that DAO, and its testnet support is unverified (see [ecosystem](ecosystem.md)). Map, evidence, runbook: [sputnik-authority.md](sputnik-authority.md); Trezu documents no testnet support (checked 2026-11-09). |

## Rules for implementation

**Window.** The protocol sets `dao_vote_window` (a duration). Like the fee policy, the value is **snapshotted into each battle at creation**, so a later change affects only future battles and cannot shorten or extend a vote in progress. The window is `[w0, w0 + window)`, where `w0` is the block time at which the final winner is recorded (`hold_principal_from_scoring`). A vote at or after the end is refused.

**Votes.** One vote per (battle, participant account), with a burn percentage (0 to 100) and weight equal to that account's snapshotted position in the winning community. The caller must be the participant itself (`predecessor_account_id`). A vote is final once cast. Votes, weights and running totals are public.

**Tally.** After the window closes, anyone may call finalize:

- If `B + R = 0`, the battle is recorded as `undecided_escrowed` and nothing moves. A later finalize call changes nothing.
- Otherwise, for each winning participant `i` with principal `p_i`:
  - `burn_i = floor(p_i * B / (B + R))`
  - `return_i = p_i - burn_i`
  - Total burn = `sum(burn_i)`, total return = `sum(return_i)`, and `burn + return = escrow` exactly.
  - Rounding is toward return, so no more is burned than the votes authorize. The math is exact and checked (no floating point, no overflow).
- The decision is stored once, bound to the battle id, the winning token, the escrow amount, `B`, `R`, the window and the per-participant portions. It is immutable afterwards.

**Execution.** Each portion is executed at most once through the token's ledger, so the same units cannot be both returned and burned:

- Return portions become entitlements for each participant, handled exactly like rewards. The holder claims them into their own NEAR account (`claim_entitlement_as_representation`, D44).
- The burn portion is destroyed on NEAR. The winning principal's tokens already left the supply when they entered escrow; the burned share is never minted again.
- Retries reuse the recorded decision; they never re-tally.

**Authorization.** The only accepted decision is the contract's own tally of authenticated votes. There is no method by which the owner, the agent, an oracle or a worker can submit or override a decision. Rewards from losing tokens stay independent of all of this.

## Trade-offs the owner accepted

- **Large holders dominate their own battle.** Weight is stake, which resists Sybil splitting (splitting an account does not add weight) but favours whales.
- **A few voters decide for everyone.** With no quorum and the split applied to the whole escrow, one voter can decide alone.
- **Principal can stay locked forever.** If nobody votes in a short window, the principal stays escrowed with no fallback. A UI prompt at the end of the battle reduces the risk; it does not remove it.
- **Open ballot.** Votes are visible, so late voters can react to the running tally.

## Implementation (issue #75)

Owner decisions taken for the implementation (D24): the window is 1 minute to 30 days, set by the protocol account.

- **Arena** (`contracts/arena/src/dao_api.rs`):
  - `set_lifecycle_dao_window(window_secs)` (protocol account, one yocto). A battle created while no window is set has no vote, and its principal stays escrowed.
  - `vote_lifecycle_disposition(battle_id, burn_percent)`. Votes and the plan use each winner's frozen position. The voter pays the storage.
  - `execute_lifecycle_disposition(battle_id, max_releases)`: permissionless, batched, and needs `reserve_lifecycle_escrow` first.
  - Views: `get_lifecycle_disposition`, `get_lifecycle_disposition_releases`.
- **Community token** (`contracts/backing/src/dao.rs`):
  - `release_escrow_return`: escrow → the winner's entitlement.
  - `release_escrow_burn`: escrow → the burned share, recorded in the ledger and never minted again.
  - `get_escrow_disposition`: returned, burned and still escrowed amounts.

## Protocol authority under a SputnikDAO (issue #113, D28)

The vote above is unchanged. Protocol-level changes (`set_lifecycle_dao_window`, `set_lifecycle_fee`, the reference-token registry and the protocol fee recipient) go to a SputnikDAO council through one-yocto `FunctionCall` proposals. Automated roles (agent, oracle, scheduler) and the deploy key stay outside the DAO. Method map, evidence, runbook and open questions: [sputnik-authority.md](sputnik-authority.md). The DAO is deployed on testnet as `valtrum-protocol.sputnikv2.testnet`.

## Open items left by this design

- The concrete default window value at deployment (within the decided 1 minute to 30 days).
