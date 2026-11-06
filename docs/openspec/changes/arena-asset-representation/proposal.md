## Why

Deliver backed asset representation as a reviewable part of the NEAR/Robinhood testnet arena. Other capabilities remain independently tracked.

## What Changes

- Implement and verify the `arena-asset-representation` requirements.
- Respect shared custody, oracle, signer and player authorization boundaries.
- No mainnet deployment or legacy asset migration.

## Capabilities

### New Capabilities

- `arena-asset-representation`: Backed asset representation.

### Modified Capabilities

None.

## Impact

Dependencies: Define deposit and custody interface with lifecycle. Existing implementation in `feat/openspec-redesign-arena` is reference material, not accepted implementation. See [coordination](../../README.md).
