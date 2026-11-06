## Why

Deliver settlement and adjustable fees as a reviewable part of the NEAR/Robinhood testnet arena. Other capabilities remain independently tracked.

## What Changes

- Implement and verify the `arena-settlement` requirements.
- Respect shared custody, oracle, signer and player authorization boundaries.
- No mainnet deployment or legacy asset migration.

## Capabilities

### New Capabilities

- `arena-settlement`: Settlement and adjustable fees.

### Modified Capabilities

None.

## Impact

Dependencies: Requires lifecycle snapshot, scoring result and backing entitlement interfaces. Existing implementation in `feat/openspec-redesign-arena` is reference material, not accepted implementation. See [coordination](../../README.md).
