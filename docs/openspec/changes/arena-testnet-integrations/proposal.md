## Why

Deliver testnet integrations and observability as a reviewable part of the NEAR/Robinhood testnet arena. Other capabilities remain independently tracked.

## What Changes

- Implement and verify the `arena-testnet-integrations` requirements.
- Respect shared custody, oracle, signer and player authorization boundaries.
- No mainnet deployment or legacy asset migration.

## Capabilities

### New Capabilities

- `arena-testnet-integrations`: Testnet integrations and observability.

### Modified Capabilities

None.

## Impact

Dependencies: End-to-end acceptance depends on all implementation changes; research may run in parallel. Existing implementation in `feat/openspec-redesign-arena` is reference material, not accepted implementation. See [coordination](../../README.md).
