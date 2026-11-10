## Why

The chart currently consumes fixtures and the legacy sampler retains observations in memory. Real charts need durable, attributable evidence and must not imply that a decorative animation or provisional score is a contract result.

## What Changes

- Persist qualified market observations before publishing them and query bounded battle/round history.
- Bind provider mappings, policy, timestamps and gaps to every series.
- Extend the application read service/gateway and connect the existing chart component.
- Start with qualified price display; gate other modes on correct inputs and provider acceptance.
- Keep provider qualification, oracle submission and lifecycle scheduling in the testnet integration owner.

## Capabilities

### New Capabilities

- `arena-observation-delivery`: Durable, provenance-preserving chart evidence and delivery.

### Modified Capabilities

None. Archived scoring requirements remain authoritative.

## Impact

Agent market collector and file journal, read service routes and frontend chart adapters. Depends on [application reads](../arena-application-read-api/proposal.md); production evidence depends on [testnet integration](../arena-testnet-integrations/proposal.md). See the [master plan](../../plans/arena-application-integration/README.md).
