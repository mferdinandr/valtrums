# Lifecycle application handoff (#144)

Adds the read ABI/event signatures in [design.md](design.md) without removing old
methods or changing Borsh state. JSON u64/u128 stay decimal strings. The original
bare-u64 methods retain their old wire format; clients opt in using manifest ABI
`lifecycle-application-v1`. A missing new method fails unavailable, never falls back
to numeric lookup. The adapter now supports all u64 battle IDs through that ABI.

Readiness exposes actual paused/exclusive-activation/configuration, legacy activation
blockers and stored per-community backing approval identity, trust and expiry. It
reuses existing audit expiry fields. An unexpired stored approval is not proof of
current custody, solvency, provider availability or eligibility to execute an action.
Policy/config reads at separate block heights do not create an atomic snapshot.

Round events are `valtrum` / `1.0.0`, with distinct names `lifecycle_round_opened_v1`,
`lifecycle_round_pending_v1`, `lifecycle_round_resolved_v1`. Their battle/round IDs,
start/end ns and exact rational score parts are strings; candidates are bounded
community indices. Every event includes `protocol=lifecycle-v2` and frozen policy
hash. Resolved scores carry the evidence hash actually submitted for that candidate.
The scoring pass returns the exact rational values used for comparison, preserving
negative winners and avoiding float rounding or a second scoring pass. Already
recorded resolutions return their stored outcome without emitting replacement data.

Contract state retains its existing round/outcome history. The bounded history view
returns those actual outcomes with null windows/candidates/scores and `complete=false`.
It does not invent evidence for an old record. Full new evidence is in immutable
event logs plus the indexer's existing durable journal, not a second contract-side
copy of market samples. New round evidence uses no extra persistent contract fields;
existing history storage/oracle funding stays unchanged. Upgrade/state migration was
not implemented or applied. A historical backfill cannot recover events that were
never emitted. Provider/archive availability and journal bounds remain real limits.

The indexer validates all three event payloads and projects optional per-battle
`rounds[roundId]` with exact evidence, source receipt/block references and finality.
Older event streams leave that section absent. New round evidence survives restart
and is retracted with a provisional fork; unrelated relevant unknown events still
degrade health. Existing projections without these events retain their prior digest.
No financial side effect is attached to indexing. Shared read DTOs stay with #143;
round/UI enrichment is #149, market sample persistence #146, account/payout use #151,
scheduler observation submission #147 and payout events #150. No scheduler/payout
authority is added by these read methods or reducers.

Scoped security review covered the changed view/event paths: new views are read-only,
oracle/one-yocto/pause guards still precede round mutations, failed receipt logs are
not projected, exact scores remain checked integer rationals, and no new persistent
storage prefix, callback, custody receiver or privileged mutation is exposed. No new
finding was identified in that scope. Provider-declared event completeness remains
an explicit trust limitation, not a cryptographic verification claim.

## Verification and authorized deployment

Native Rust workspace: 695 tests passed; focused arena rerun: 405 passed. Rust fmt
and all-target clippy with `-D warnings` pass. The lifecycle sandbox integration:
3 tests pass, including v1/legacy parity, string serialization, readiness and partial
history. Sandbox evidence remains fixture evidence. Agent suite: 733 tests across
73 files; web suite: 230 across 22 files. Typecheck and package builds pass.

At the user's subsequent explicit request, a **new** testnet arena was deployed,
rather than upgrading the old deployment. Public evidence is in
[the deployment record](../../../evidence/2026-11-10-application-read-deploy.json).
Account: `valtrum-read144-261110.testnet`; code hash:
`52Nb2KFgkSTh5xBfkH2Gsv1iXjajwW6wgBAQsgrSDE6D`. Deployment+initialization transaction:
`6kF9f8R5BfUDXHFcDctK1ekdnGuGAJDumb4ihnobYgbq`, final execution `FINAL`.
Faucet funded this new account; no existing player/owner balance funded it. Credentials
were generated locally outside the repository and are not part of this handoff.

Post-deploy finalized views confirm count `"0"`, exact max-u64 lookup returns null,
code hash matches, `activated=false`, zero legacy battles and unset protocol/oracle/
policy. This verifies deploy/read compatibility only. No lifecycle activation,
financial action, new backing/registry wiring, battle or funded end-to-end run was
performed. The initialized USDC account is the existing fixture placeholder, not a
verified financial dependency. Canonical discovery remains disabled until deployment
coverage and independent live acceptance are established.

The [staging manifest](../arena-application-read-api/application-manifest.testnet-read144.json)
opts into this ABI explicitly. For the existing read server set
`ARENA_APPLICATION_MANIFEST_PATH` to that file. The web opt-in is
`NEXT_PUBLIC_ARENA_READ_DEPLOYMENT=near-testnet-read144-v1`,
`NEXT_PUBLIC_ARENA_READ_PROTOCOL=lifecycle-v2`,
`NEXT_PUBLIC_NEAR_NETWORK=testnet`, and
`NEXT_PUBLIC_ARENA_CONTRACT_ID=valtrum-read144-261110.testnet`.
Registry/audit capabilities remain disabled with reasons. No signing key is needed
to consume the deployment's public views.
