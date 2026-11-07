## Why

Deliver scoring and overtime as a reviewable part of the NEAR/Robinhood testnet arena. Other capabilities remain independently tracked.

## What Changes

- Implement and verify the `arena-scoring` requirements.
- Respect shared custody, oracle, signer and player authorization boundaries.
- No mainnet deployment or legacy asset migration.

## Capabilities

### New Capabilities

- `arena-scoring`: Scoring and overtime.

### Modified Capabilities

None.

## Impact

Dependencies: Coordinate frozen policy and round interface with lifecycle. Existing implementation in `feat/openspec-redesign-arena` is reference material, not accepted implementation. See [coordination](../../README.md).
