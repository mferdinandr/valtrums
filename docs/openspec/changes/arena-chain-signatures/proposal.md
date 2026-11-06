## Why

Deliver reservation-bound signing and payout as a reviewable part of the NEAR/Robinhood testnet arena. Other capabilities remain independently tracked.

## What Changes

- Implement and verify the `arena-chain-signatures` requirements.
- Respect shared custody, oracle, signer and player authorization boundaries.
- No mainnet deployment or legacy asset migration.

## Capabilities

### New Capabilities

- `arena-chain-signatures`: Reservation-bound signing and payout.

### Modified Capabilities

None.

## Impact

Dependencies: Requires backing reservations and settlement entitlements. Existing implementation in `feat/openspec-redesign-arena` is reference material, not accepted implementation. See [coordination](../../README.md).
