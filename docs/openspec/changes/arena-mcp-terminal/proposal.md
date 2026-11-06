## Why

Deliver mcp and terminal as a reviewable part of the NEAR/Robinhood testnet arena. Other capabilities remain independently tracked.

## What Changes

- Implement and verify the `arena-mcp-terminal` requirements.
- Respect shared custody, oracle, signer and player authorization boundaries.
- No mainnet deployment or legacy asset migration.

## Capabilities

### New Capabilities

- `arena-mcp-terminal`: MCP and terminal.

### Modified Capabilities

None.

## Impact

Dependencies: Requires player authorization and stable read/preview interfaces. Existing implementation in `feat/openspec-redesign-arena` is reference material, not accepted implementation. See [coordination](../../README.md).
