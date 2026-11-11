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

## Open arena (D34 to D38)

Contract and agent work is on `feat/open-arena-contract` and `feat/open-arena-agent`; see [contract notes](open-arena-contract-notes.md) and [agent notes](open-arena-agent-notes.md). Checked items are sandbox- or fixture-verified only.

- [x] Accept creation with zero to sixteen communities and an optional start time between now + 60 s and now + 7 days; move the two-community minimum to the lock.
- [x] Add the protocol-only joinable-asset allowlist (one yocto, at most 64 entries) with paged views and set/remove events.
- [x] Add `join_lifecycle_battle`: allowlisted representation only, appends a new community or reuses an existing one, registers the caller's position and refunds excess storage.
- [x] Refuse join, registration and deposit from the start time on and after a cancel; refuse the lock before the start time.
- [x] Gate deposits on the target community's approvals only; lock on fresh approvals for every funded community with at least two funded; exclude empty vaults from rounds and principal.
- [x] Add permissionless cancel below two funded communities after the start and pull-based refunds with rollback on a failed transfer.
- [x] Prove state compatibility by redeploying over the previous main wasm in the sandbox (no layout change; new state in appended storage keys).
- [x] Agent: create with a start time, join, cancel and refund actions; lock at the start over funded communities; backing refresh on by default; optional cancel pass; index the new events.
- [ ] Model `lifecycle_refund_failed`, `lifecycle_joinable_asset_set` and `lifecycle_joinable_asset_removed` in the indexer so allowlist proposals do not report degraded.
- [ ] Testnet: redeploy the arena in place, register the five allowlisted tokens through DAO proposals, remove AI's backing from the trusted list, and run one start-time arena and one cancel-and-refund drill.

## Application read/view compatibility follow-up

New application requirements discovered during integration mapping; completed contract work above is preserved. The [read API](../arena-application-read-api/tasks.md) consumes views; [testnet integrations](../arena-testnet-integrations/tasks.md) owns live indexing. Review corresponding capability deltas before implementing new ABI/state requirements.

- [x] Define and implement reviewed versioned activation/readiness and lossless u64 discovery boundaries needed by application reads; reuse the already exported `audit_expires_at_ms`, add only missing configuration/backing fields and expose missing capabilities explicitly.
- [x] Define and implement round-history, frozen-window, exact-score/evidence and pending-resolution views/events consistent with the [scoring spec](../../specs/arena-scoring/spec.md); distinguish existing stored fields from genuinely new state.
- [x] Document deployment/upgrade/storage implications and historical backfill limits, coordinate event schema with indexer consumers, and verify serialization/compatibility; never fabricate missing past scores or evidence.

Verified #144 scope and the subsequent authorized new testnet deployment are recorded
in [application-handoff.md](application-handoff.md). Full evidence is event-backed;
stored outcome history remains explicitly incomplete. No layout migration or lifecycle
activation was performed; no financial/live end-to-end acceptance is implied.
