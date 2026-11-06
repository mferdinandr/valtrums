## Why

Deliver permissionless arena lifecycle as a reviewable part of the NEAR/Robinhood testnet arena. Other capabilities remain independently tracked.

## What Changes

- Implement and verify the `arena-lifecycle` requirements.
- Respect shared custody, oracle, signer and player authorization boundaries.
- No mainnet deployment or legacy asset migration.

## Capabilities

### New Capabilities

- `arena-lifecycle`: Permissionless arena lifecycle.

### Modified Capabilities

None.

## Impact

Dependencies: Coordinate backing deposits and audit approval. Existing implementation in `feat/openspec-redesign-arena` is reference material, not accepted implementation. See [coordination](../../README.md).
