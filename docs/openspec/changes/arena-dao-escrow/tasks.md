# Tasks

Check tasks only after implementation and verification. Governance is decided (D22, [dao-governance.md](../../../dao-governance.md)); do not add a timeout or fallback beyond it.

## Principal isolation

- [x] Bind the winning principal hold to the frozen winning asset, amount and participant attribution. (`lifecycle_guards.rs`; the escrow record is bound to battle, community and amount, `escrow_api.rs`)
- [x] Integrate an exclusive backing reservation for escrow without blocking losing-token entitlements. (backing `escrow` bucket and `reserve_principal_escrow`, arena `reserve_lifecycle_escrow`; sandbox-tested)
- [x] Keep principal escrowed indefinitely while no valid governance decision exists. (no method moves units out of `escrow`; the D22 vote is #75)
- [x] Test unresolved governance, independent reward availability and denial of owner-only or worker-only disposition.

## Governance design gate

- [x] Obtain explicit decisions on DAO membership, voting weight, quorum, deadlines, delegation and fallback. (Owner, 2026-11-08, D22.)
- [x] Specify authorized decision verification, eligible burn/return proportions and execution authority for review. (`docs/dao-governance.md`.)
- [x] Obtain approval of the governance and disposition design before implementing an authoritative decision path. (Approved by the owner on 2026-11-08 by merging PR #99.)

## Decision-bound execution

- [x] Bind each approved decision to escrow identity, authorized burn/return portions and destination or disposal action. (`arena/src/dao_api.rs`: releases derive from the contract's own tally, carry ids bound to arena, battle and position, and name the escrow id; returns name the winner, the burn the backing's frozen sink.)
- [x] Ensure total reserved portions do not exceed escrow and the same backing cannot be returned, redeemed and burned. (`backing/src/dao.rs`: per-escrow release totals are bounded by the escrow; returns move escrow to entitlements, the burn to disposal; one id cannot be both.)
- [x] Execute each decision portion at most once through exclusive reservations. (Idempotent release ids in the backing; batched execution with a cursor that only advances after every backing call succeeded.)
- [x] Verify source-chain return or underlying burn/sink separately from destruction of NEAR representations. (A burn is confirmed only by a finalized debit to the sink through `confirm_payout`; returns pay out through the entitlement payout path. Representation burns at escrow time never count.)
- [x] Expose pending versus confirmed source disposition accurately. (`get_lifecycle_disposition` and `get_lifecycle_disposition_releases` on the arena; `get_escrow_disposition` on the backing separates burn pending and burn confirmed.)
- [x] Test split decisions, replay, competing reservations, unauthorized decisions and representation-only burn evidence. (Unit tests in `dao_api.rs` and backing `lib.rs`; sandbox: `lifecycle_integration` two-community battle votes, executes and confirms the burn; `payout` DAO burn through signing and confirmation. Fixtures only.)
