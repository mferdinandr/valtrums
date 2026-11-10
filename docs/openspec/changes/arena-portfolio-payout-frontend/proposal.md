## Why

The portfolio still models legacy claims, while lifecycle settlement and payout use independent entitlements, reservations and reconciliation states. Players need accurate account reads and wallet requests without confusing a submitted payout with delivered funds.

## What Changes

- Extend application reads with account positions, settlement progress, entitlements and attributable payout history.
- Present reward availability, reserved amounts, delivered amounts and principal holds separately.
- Add reviewed wallet request adapters, stable request identities and status/recovery UX.
- Preserve original-token asset identity and separate late-fund refund paths from reward payouts.
- **BREAKING, opt-in:** lifecycle portfolio models replace legacy claim/withdraw assumptions; legacy support remains separate.
- Exclude signer, broadcaster, confirmation-operator wiring and DAO release policy.

## Capabilities

### New Capabilities

- `arena-portfolio-payout-client`: Account reads and reservation-aware payout request UX.

### Modified Capabilities

None. Settlement, signing and DAO requirements retain their original owners.

## Impact

Portfolio route, account read adapters/gateway extensions and wallet request codecs. Depends on [application reads](../arena-application-read-api/proposal.md), backing/settlement contracts and [payout runtime](../arena-chain-signatures/proposal.md). See the [master plan](../../plans/arena-application-integration/README.md).
