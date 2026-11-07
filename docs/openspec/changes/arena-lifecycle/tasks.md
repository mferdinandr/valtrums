# Tasks

Check tasks only after implementation and verification. Coordinate audit and backing interfaces with their owning changes; fixtures are not live evidence.

## Creation and deposits

- [x] Validate two or more distinct source-chain/token identities and unique representation accounts at creation.
- [x] Store creator, authenticated protocol identity, fixed mode and creation-time fee configuration without a proposal bond.
- [x] Require storage funding and position registration before accepting representation transfers.
- [ ] Integrate authenticated audit and backing approvals per community and reject mismatched asset evidence.
- [ ] Credit only actual backed deposits to their attributed participant and community before lock.
- [ ] Require a positive backed creator position and nonempty vault for every community, including protocol-created battles.
- [ ] Verify two- and three-community creation, invalid identities, missing approvals, empty vaults and absent creator stake.

## Lock and late arrivals

- [x] Freeze identities, positions, vault totals, creator participation, mode, fee identity and policy references before round one.
- [x] Make repeated lock calls idempotent and preserve the original snapshot after configuration changes.
- [x] Refuse deposits and snapshot changes throughout live rounds and overtime.
- [ ] Specify and integrate attribution and recovery for foreign deposits arriving after lock with the backing change.
- [x] Ensure post-lock audit refreshes cannot alter the snapshot, live state, round or result.
- [ ] Test duplicate lock, late representation transfers, late foreign arrivals and post-lock audit updates.

## Principal boundary

- [x] Hold the entire final winning vault separately from losing-vault settlement inputs.
- [x] Keep principal locked without a valid future DAO decision and expose no owner-only or worker-only disposition.
- [x] Verify unresolved governance does not block independently backed losing-token rewards.
- [ ] Verify lifecycle integration with backing, audit and scoring before claiming live acceptance.
