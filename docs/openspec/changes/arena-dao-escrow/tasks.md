# Tasks

Check tasks only after implementation and verification. Governance remains OPEN; do not invent an owner decision, timeout or fallback.

## Principal isolation

- [ ] Bind the winning principal hold to the frozen winning asset, amount and participant attribution.
- [ ] Integrate an exclusive backing reservation for escrow without blocking losing-token entitlements.
- [ ] Keep principal escrowed indefinitely while no valid governance decision exists.
- [ ] Test unresolved governance, independent reward availability and denial of owner-only or worker-only disposition.

## Governance design gate

- [ ] Obtain explicit decisions on DAO membership, voting weight, quorum, deadlines, delegation and fallback.
- [ ] Specify authorized decision verification, eligible burn/return proportions and execution authority for review.
- [ ] Obtain approval of the governance and disposition design before implementing an authoritative decision path.

## Decision-bound execution

- [ ] Bind each approved decision to escrow identity, authorized burn/return portions and destination or disposal action.
- [ ] Ensure total reserved portions do not exceed escrow and the same backing cannot be returned, redeemed and burned.
- [ ] Execute each decision portion at most once through exclusive reservations.
- [ ] Verify source-chain return or underlying burn/sink separately from destruction of NEAR representations.
- [ ] Expose pending versus confirmed source disposition accurately.
- [ ] Test split decisions, replay, competing reservations, unauthorized decisions and representation-only burn evidence.
