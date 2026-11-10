## Why

The frontend reads the legacy ABI while lifecycle and agent components expose separate interfaces. A read-only application boundary is needed before integrating real lifecycle data without confusing fixtures with confirmed state.

## What Changes

- Add a validated deployment manifest, namespaced identifiers, capability flags and provenance envelopes.
- Add a read-only service and same-origin gateway for battle discovery/detail, asset search, audit reports and dependency health.
- Move list and searchable-dropdown filtering to bounded backend queries.
- Reject unsafe numeric IDs and report unsupported or incomplete views explicitly.
- Keep wallet writes, market collection, worker wiring and canonical action/auth services outside this change.
- **BREAKING, opt-in:** lifecycle consumers use versioned DTOs rather than legacy A/B models; legacy adapters remain explicit.

## Capabilities

### New Capabilities

- `arena-application-reads`: Namespaced, capability-gated and queryable application reads.

### Modified Capabilities

None. Financial and worker requirements retain their existing owners.

## Impact

Agent read adapters/service, Next.js read gateway, frontend provider selection and query hooks. Contract views and live indexer production remain prerequisites owned by lifecycle and testnet integration. See the [master plan](../../plans/arena-application-integration/README.md).
