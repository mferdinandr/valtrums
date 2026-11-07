# Tasks

Check tasks only after implementation and verification. Coordinate lifecycle snapshots, verified scoring and backing entitlements before live allocation.

## Fee configuration

- [ ] Restrict total fee and creator-share configuration to protocol authority and validate each value in 0–10000 bps.
- [x] Set initial defaults to 10 bps total fee and 5000 bps creator share.
- [ ] Snapshot fee, split, authenticated creator type and protocol recipient at battle creation.
- [ ] Verify later configuration changes affect only future battles and invalid values are rejected.

## Per-token allocation

- [x] Read each original losing vault from the frozen snapshot, including communities eliminated in overtime.
- [x] Aggregate each winning beneficiary's deposits and use the final winning vault as the weight denominator.
- [x] Compute each vault's total fee once with checked wide arithmetic and floor division; assign the remainder to the winner pool.
- [x] Split a user-created fee by floor creator share and protocol remainder; assign a protocol-created fee entirely to protocol.
- [x] Allocate the winner pool by largest remainder with canonical account-ID byte ordering for ties.
- [ ] Persist an immutable allocation ID and asset-bound entitlements so retries cannot allocate or charge twice.
- [x] Handle zero recipient shares and tiny vaults without failing unrelated allocations.
- [x] Verify the 100000-unit 60/40 example, 10003-unit and 999/1000-unit fee cases, and 1:2:3 dust ordering.
- [ ] Verify per-token conservation and deterministic results across pagination, claim order and two/three communities.

## Entitlement boundary

- [ ] Expose available, reserved, broadcast, confirmation-pending and confirmed states without treating a hash as payment.
- [ ] Allow independently backed losing-token rewards to proceed while winning principal awaits DAO disposition.
- [ ] Test independent token payout progress and lost-response retry without repeating allocation or fees.
