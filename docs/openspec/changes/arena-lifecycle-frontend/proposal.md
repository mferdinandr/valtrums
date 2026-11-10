## Why

The current create/deposit frontend signs legacy A/B transactions despite target lifecycle contracts supporting multiple communities. The integrated 3D arena needs authoritative lifecycle state and wallet flows that match the actual backing and round interfaces.

## What Changes

- Add an explicit lifecycle adapter for multi-community discovery, creation, storage registration and supported deposit paths.
- Bind assets to chain, token, representation and custody identities instead of ticker matching.
- Drive rounds and the 3D runtime from confirmed records; show unavailable evidence and pending states honestly.
- Keep legacy economics separate and block actions when deployment, audit, custody or contract capabilities are unverified.
- **BREAKING, opt-in:** lifecycle routes replace A/B assumptions; no automatic state conversion or deployment activation.

## Capabilities

### New Capabilities

- `arena-lifecycle-client`: Capability-gated lifecycle wallet UX and authoritative arena presentation.

### Modified Capabilities

None. Contract lifecycle, scoring, backing and audit requirements keep their existing owners.

## Impact

Web providers, Arena/Create/Detail routes, wallet adapters and integrated 3D runtime. Depends on [application reads](../arena-application-read-api/proposal.md) and verified owning contract/worker interfaces; charts are an independent enhancement. See the [master plan](../../plans/arena-application-integration/README.md).
