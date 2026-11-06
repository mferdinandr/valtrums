## Why

Deliver dao escrow and disposition as a reviewable part of the NEAR/Robinhood testnet arena. Other capabilities remain independently tracked.

## What Changes

- Implement and verify the `arena-dao-escrow` requirements.
- Respect shared custody, oracle, signer and player authorization boundaries.
- No mainnet deployment or legacy asset migration.

## Capabilities

### New Capabilities

- `arena-dao-escrow`: DAO escrow and disposition.

### Modified Capabilities

None.

## Impact

Dependencies: Requires lifecycle escrow and backing reservations; governance remains OPEN. Existing implementation in `feat/openspec-redesign-arena` is reference material, not accepted implementation. See [coordination](../../README.md).
