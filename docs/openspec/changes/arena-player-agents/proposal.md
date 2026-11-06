## Why

Deliver bounded player agents as a reviewable part of the NEAR/Robinhood testnet arena. Other capabilities remain independently tracked.

## What Changes

- Implement and verify the `arena-player-agents` requirements.
- Respect shared custody, oracle, signer and player authorization boundaries.
- No mainnet deployment or legacy asset migration.

## Capabilities

### New Capabilities

- `arena-player-agents`: Bounded player agents.

### Modified Capabilities

None.

## Impact

Dependencies: Coordinate player identity and deposit interface with lifecycle and backing. Existing implementation in `feat/openspec-redesign-arena` is reference material, not accepted implementation. See [coordination](../../README.md).
