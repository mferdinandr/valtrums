## Why

The legacy two-side swap/credit arena cannot express the agreed permissionless Robinhood hackathon product. This proposal specifies a new testnet target; documentation completion does not implement it.

## What Changes

- **BREAKING**: replace fixed A/B battles with two-or-more-community snapshots and mandatory real creator participation; remove the bond.
- **BREAKING**: replace TWAP price-only scoring and tie refunds with four modes, 30-second point-observation rounds and unlimited leader-only overtime.
- **BREAKING**: replace Ref/USDC swap settlement and credit rewards with per-losing-token 99.9/0.05/0.05 allocation and Robinhood payouts.
- Add 1:1 actual-received representations, exclusive redemption/disposal reservations, principal DAO escrow, constrained signing, bounded player agents and MCP.
- Preserve OPEN DAO design and audit tax/admin policy; verify all testnet integrations before claims.

## Capabilities

### New Capabilities

- `arena-lifecycle`: Permissionless creation with real creator participation; Immutable pre-round snapshot.
- `arena-scoring`: Four exact scoring modes; Thirty-second point-observation rounds; Unlimited leader-only overtime.
- `arena-audit`: Critical risk rejection and unknown-data hold; Independent strict liquidity gate.
- `arena-asset-representation`: Actual-received one-to-one backing; Exclusive backing reservation.
- `arena-settlement`: Per-token rewards and revenue; Deterministic conserving rounding; Original-token asynchronous payout.
- `arena-dao-escrow`: Winning principal isolation; Decision-bound underlying disposition.
- `arena-chain-signatures`: Constrained reservation-bound signing; Final receipt confirmation.
- `arena-player-agents`: Bounded user delegation; Untrusted strategy output.
- `arena-mcp-terminal`: Read preview authorize execute boundary; Unsupported routing transparency.
- `arena-testnet-integrations`: Verified testnet-only acceptance; End-to-end evidence and observability.

### Modified Capabilities

None. The earlier battle-credit and settlement-burn specs were removed; this change is the only spec for the arena.

## Impact

Future work affects arena state/APIs, asset contracts/custody, foreign signing, scheduler/oracle/indexer, audit services, player authorization, web/terminal and MCP. This PR changes documentation and OpenSpec configuration only. It deploys nothing, does not migrate funds and does not touch the separate VALT rebase.

The parent-folder OpenSpec archive remains historical and is not copied here. Its Ref swap, TWAP, bond and credit plans are superseded for this target. Existing repository WAR/furnace proposals retain historical task status; this change is not archived as completed.

Product source: [product-spec.md](../../../product-spec.md). Implementation tracker: [parent issue draft](../../../implementation-tracker.md).
