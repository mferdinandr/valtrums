# OpenSpec coordination

These ten changes supersede `redesign-permissionless-robinhood-arena`; it is not archived as completed. Each change gets a branch, implementation PR and review. Check individual tasks only after implementation and verification; see each task list for current progress. The mixed implementation on `feat/openspec-redesign-arena` is reference only.

| Order | Change | Dependencies and parallel work |
| --- | --- | --- |
| 1 | [Permissionless arena lifecycle](changes/arena-lifecycle/proposal.md) | Coordinate backing deposits and audit approval |
| 2 | [Backed asset representation](changes/arena-asset-representation/proposal.md) | Define deposit and custody interface with lifecycle |
| 3 | [GoPlus and liquidity audit](changes/arena-audit/proposal.md) | Coordinate approval interface with lifecycle |
| 4 | [Scoring and overtime](changes/arena-scoring/proposal.md) | Coordinate frozen policy and round interface with lifecycle |
| 5 | [Settlement and adjustable fees](changes/arena-settlement/proposal.md) | Requires lifecycle snapshot, scoring result and backing entitlement interfaces |
| 6 | [Reservation-bound signing and payout](changes/arena-chain-signatures/proposal.md) | Requires backing reservations and settlement entitlements |
| 7 | [DAO escrow and disposition](changes/arena-dao-escrow/proposal.md) | Requires lifecycle escrow and backing reservations; governance remains OPEN |
| 8 | [Bounded player agents](changes/arena-player-agents/proposal.md) | Coordinate player identity and deposit interface with lifecycle and backing |
| 9 | [MCP and terminal](changes/arena-mcp-terminal/proposal.md) | Requires player authorization and stable read/preview interfaces |
| 10 | [Testnet integrations and observability](changes/arena-testnet-integrations/proposal.md) | End-to-end acceptance depends on all implementation changes; research may run in parallel |

The [shared design](arena-design.md) preserves the cross-cutting data flow, trust boundaries and failure handling.

## Coordination and integration

- Backing, lifecycle interfaces, audit/provider research and scoring design can proceed in parallel. Merge dependent work only after prerequisite interfaces are reviewed; use draft or stacked PRs as needed.
- Lifecycle owns battle state and freeze; backing owns custody and reservations; audit supplies approval evidence; scoring supplies results; settlement owns snapshotted fee arithmetic and entitlements; signing owns payout identity and reconciliation. DAO governance remains OPEN. Agent authorization, MCP and testnet acceptance are separate boundaries.
- Shared interfaces: token identity binds chain/token/representation/custody; lifecycle exposes immutable snapshots; audit binds token and policy; scoring binds interval and source; settlement hands durable asset-bound entitlements to payout. Coordinate changes across dependent PRs.
- Original requirements and scenarios remain in their corresponding capability specs; cross-cutting acceptance is in integration tasks. The prior implementation needs independent verification.
- Default fee is 10 bps of each losing vault and creator share is 5000 bps of fee. Protocol may adjust total fee within 0–1000 bps (a 10% ceiling) and creator share within 0–10000 bps for future battles; protocol-created battles pay the whole fee to protocol. Snapshot fee and recipient at creation.
- Winning principal remains escrowed until DAO governance is designed; no owner-only decision or confirmation. Rewards are independent. Fixtures are not proof of live integration.

Run from `docs/`:

```sh
openspec validate --all --strict --no-interactive
```

Artifact readiness does not mean implementation is complete.
