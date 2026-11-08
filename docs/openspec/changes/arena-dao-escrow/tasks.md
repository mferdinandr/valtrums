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

- [ ] Bind each approved decision to escrow identity, authorized burn/return portions and destination or disposal action.
- [ ] Ensure total reserved portions do not exceed escrow and the same backing cannot be returned, redeemed and burned.
- [ ] Execute each decision portion at most once through exclusive reservations.
- [ ] Verify source-chain return or underlying burn/sink separately from destruction of NEAR representations.
- [ ] Expose pending versus confirmed source disposition accurately.
- [ ] Test split decisions, replay, competing reservations, unauthorized decisions and representation-only burn evidence.
