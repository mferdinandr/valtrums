# Tasks

Check tasks only after implementation and verification. Coordinate audit and backing interfaces with their owning changes; fixtures are not live evidence.

## Creation and deposits

- [x] Validate two or more distinct source-chain/token identities and unique representation accounts at creation.
- [x] Store creator, authenticated protocol identity, fixed mode and creation-time fee configuration without a proposal bond.
- [x] Require storage funding and position registration before accepting representation transfers.
- [x] Integrate authenticated audit and backing approvals per community and reject mismatched asset evidence.
- [x] Credit only actual backed deposits to their attributed participant and community before lock.
- [x] Require a positive backed creator position and nonempty vault for every community, including protocol-created battles.
- [x] Verify two- and three-community creation, invalid identities, missing approvals, empty vaults and absent creator stake.

## Lock and late arrivals

- [x] Freeze identities, positions, vault totals, creator participation, mode, fee identity and policy references before round one.
- [x] Make repeated lock calls idempotent and preserve the original snapshot after configuration changes.
- [x] Refuse deposits and snapshot changes throughout live rounds and overtime.
- [x] Specify and integrate attribution and recovery for foreign deposits arriving after lock with the backing change.
- [x] Ensure post-lock audit refreshes cannot alter the snapshot, live state, round or result.
- [x] Test duplicate lock, late representation transfers, late foreign arrivals and post-lock audit updates.

## Principal boundary

- [x] Hold the entire final winning vault separately from losing-vault settlement inputs.
- [x] Keep principal locked without a valid future DAO decision and expose no owner-only or worker-only disposition.
- [x] Verify unresolved governance does not block independently backed losing-token rewards.
- [x] Verify lifecycle integration with backing, audit and scoring before claiming live acceptance.

## Application read/view compatibility follow-up

New application requirements discovered during integration mapping; completed contract work above is preserved. The [read API](../arena-application-read-api/tasks.md) consumes views; [testnet integrations](../arena-testnet-integrations/tasks.md) owns live indexing. Review corresponding capability deltas before implementing new ABI/state requirements.

- [ ] Define and implement reviewed versioned activation/readiness and lossless u64 discovery boundaries needed by application reads; reuse the already exported `audit_expires_at_ms`, add only missing configuration/backing fields and expose missing capabilities explicitly.
- [ ] Define and implement round-history, frozen-window, exact-score/evidence and pending-resolution views/events consistent with the [scoring spec](../../specs/arena-scoring/spec.md); distinguish existing stored fields from genuinely new state.
- [ ] Document deployment/upgrade/storage implications and historical backfill limits, coordinate event schema with indexer consumers, and verify serialization/compatibility; never fabricate missing past scores or evidence.
