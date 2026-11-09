# DAO governance of winning principal

Design for issue [#74](https://github.com/mferdinandr/valtrum/issues/74), decided by the owner on 2026-11-08 (decision D22 in the [decision log](findings-and-decisions.md)). It resolves OQ-DAO in the [product specification](product-spec.md). The owner approved this design on 2026-11-08 (PR [#99](https://github.com/mferdinandr/valtrum/pull/99)). Nothing here is implemented yet; the execution issue ([#75](https://github.com/mferdinandr/valtrum/issues/75)) implements it.

## What is being decided

Battle rounds last 30 seconds and only decide the winner. After the final winner exists:

- Participants on the winning community receive the losing tokens immediately. That does **not** depend on this vote.
- The winning community's **own deposits (the winning principal)** stay locked in DAO escrow. The vote decides what happens to them: **burn** (send to an irrecoverable sink) or **return** (give back to their owners).

## Owner decisions

| Topic | Decision |
| --- | --- |
| Membership | Per battle: the registered participants of the final winning community, as frozen in the battle snapshot. Losing and eliminated communities do not vote. The creator votes only if they are a participant of the winning community. |
| Voting weight | Each voter's escrowed principal in that battle (their snapshotted position amount). |
| Decision | A pro-rata split. Each voter casts all their weight for `burn` or `return`. The burn share is `B / (B + R)` of the votes cast, where `B` is the burn weight and `R` the return weight. |
| Non-voters | The split applies to the **whole** escrow, so non-voters follow the voters. |
| Quorum | None. |
| Window | Opens when the final winner is recorded. Its length is a protocol-adjustable parameter. |
| Fallback | If no vote at all is cast in the window (`B + R = 0`), the principal **stays escrowed**. There is no timeout, automatic return or automatic burn. |
| Delegation | None in v1. Only the participant's own account votes, and a player agent cannot vote unless a later grant design explicitly allows it. |
| Execution | The arena contract tallies the votes itself. After the window closes, **anyone** can trigger finalization and execution. No owner, worker, multisig or external DAO can create, change or veto a decision. |
| Burn method | A verified transfer of the burn portion on Robinhood to a frozen irrecoverable sink address, confirmed by a finalized receipt. It is reported as "sent to sink", not as a supply reduction. |
| SputnikDAO, Trezu | Not used for the winners' vote, which the arena contract tallies (D22). Since D28 (2026-11-09) a SputnikDAO on testnet is planned to own protocol-level authority and receive the protocol fee ([#113](https://github.com/mferdinandr/valtrum/issues/113)); it cannot change or veto a battle's tally. Trezu is only an optional interface to that DAO, and its testnet support is unverified (see [ecosystem](ecosystem.md)). |

## Rules for implementation

**Window.** The protocol sets `dao_vote_window` (a duration). Like the fee policy, the value is **snapshotted into each battle at creation**, so a later change affects only future battles and cannot shorten or extend a vote in progress. The window is `[w0, w0 + window)`, where `w0` is the block time at which the final winner is recorded (`hold_principal_from_scoring`). A vote at or after the end is refused.

**Votes.** One vote per (battle, participant account), with choice `burn` or `return` and weight equal to that account's snapshotted position in the winning community. The caller must be the participant itself (`predecessor_account_id`). A vote is final once cast. Votes, weights and running totals are public.

**Tally.** After the window closes, anyone may call finalize:

- If `B + R = 0`, the battle is recorded as `undecided_escrowed` and nothing moves. A later finalize call changes nothing.
- Otherwise, for each winning participant `i` with principal `p_i`:
  - `burn_i = floor(p_i * B / (B + R))`
  - `return_i = p_i - burn_i`
  - Total burn = `sum(burn_i)`, total return = `sum(return_i)`, and `burn + return = escrow` exactly.
  - Rounding is toward return, so no more is burned than the votes authorize. The math is exact and checked (no floating point, no overflow).
- The decision is stored once, bound to the battle id, the winning asset identity (chain, token, representation, custody domain), the escrow amount, `B`, `R`, the window and the per-participant portions. It is immutable afterwards.

**Execution.** Each portion is executed at most once through exclusive backing reservations, so the same backing cannot be returned, redeemed and burned:

- Return portions become payout entitlements to each participant's bound destination, paid through the existing payout path. Their states are available, pending and confirmed, as for rewards.
- The burn portion becomes one payout to the frozen sink address on Robinhood. The matching NEAR representations are retired only after the finalized receipt confirms the transfer. Until then the UI shows "pending", never "burned".
- Retries reuse the recorded decision and reservations; they never re-tally.

**Authorization.** The only accepted decision is the contract's own tally of authenticated votes. There is no method by which the owner, the agent, an oracle or a worker can submit or override a decision. Rewards from losing tokens stay independent of all of this.

## Trade-offs the owner accepted

- **Large holders dominate their own battle.** Weight is stake, which resists Sybil splitting (splitting an account does not add weight) but favours whales.
- **A few voters decide for everyone.** With no quorum and the split applied to the whole escrow, one voter can decide alone.
- **Principal can stay locked forever.** If nobody votes in a short window, the principal stays escrowed with no fallback. A UI prompt at the end of the battle reduces the risk; it does not remove it.
- **Open ballot.** Votes are visible, so late voters can react to the running tally.
- **Burn is a sink, not a supply burn.** Total supply of the Robinhood token does not change; reports must say "sent to sink".

## Implementation (issue #75)

Owner decisions taken for the implementation (D24): the window is 1 minute to 30 days, set by the protocol account; the sink is set once per token by the backing owner; a burn whose transfer provably did not happen stays reserved and is retried, never released back.

- **Arena** (`contracts/arena/src/dao_api.rs`):
  - `set_lifecycle_dao_window(window_secs)` (protocol account, one yocto). A battle created while no window is set has no vote, and its principal stays escrowed.
  - `vote_lifecycle_disposition(battle_id, burn)`. Votes and the plan use each winner's frozen position. The voter pays the storage.
  - `execute_lifecycle_disposition(battle_id, max_releases)`: permissionless, batched, and needs `reserve_lifecycle_escrow` first.
  - Views: `get_lifecycle_disposition`, `get_lifecycle_disposition_releases`.
- **Backing** (`contracts/backing/src/dao.rs`):
  - `set_dao_sink` (owner, once).
  - `release_escrow_return`: escrow → the winner's entitlement.
  - `release_escrow_burn`: escrow → a disposal reservation to the sink, held by the arena under the release id.
  - `reserve_dao_burn`: payout authority only. It hands the reservation to the payout contract.
  - `get_escrow_disposition`: returned, burn pending, burn confirmed, still escrowed.
  - `confirm_payout` consumes a DAO burn only with a finalized debit to the sink.
- **Payout** (`contracts/payout/src/contract.rs`): `request_dao_burn(backing, holder, request_id, destination)`. It's permissionless (the operator attaches one yocto, anyone else the request deposit), then follows the normal signing and confirmation path. A failed request refunds whoever paid.

## Open items left by this design

- The concrete default window value at deployment (within the decided 1 minute to 30 days).
- The sink address per token. `0x000000000000000000000000000000000000dEaD` is the expected default, but the owner must check per token that it accepts transfers before setting it, because it cannot be changed.
- Whether a participant's bound destination for returns is the same one used for reward payouts (expected yes; this belongs to the payout/identity work, OQ-IDENTITY).
