# OpenSpec coordination

These ten changes (arena-scoring is archived) supersede `redesign-permissionless-robinhood-arena`; it is not archived as completed. Each change gets a branch, implementation PR and review. Check individual tasks only after implementation and verification; see each task list for current progress. The mixed implementation on `feat/openspec-redesign-arena` is reference only.

| Order | Change | Dependencies and parallel work |
| --- | --- | --- |
| 1 | [Permissionless arena lifecycle](changes/arena-lifecycle/proposal.md) | Coordinate backing deposits and audit approval |
| 2 | [Backed asset representation](changes/arena-asset-representation/proposal.md) | Define deposit and custody interface with lifecycle |
| 3 | [GoPlus and liquidity audit](changes/arena-audit/proposal.md) | Coordinate approval interface with lifecycle |
| 4 | [Scoring and overtime](changes/archive/2026-11-07-arena-scoring/proposal.md) (archived; requirements in [specs/arena-scoring](specs/arena-scoring/spec.md)) | Coordinate frozen policy and round interface with lifecycle |
| 5 | [Settlement and adjustable fees](changes/arena-settlement/proposal.md) | Requires lifecycle snapshot, scoring result and backing entitlement interfaces |
| 6 | [Reservation-bound signing and payout](changes/arena-chain-signatures/proposal.md) | Requires backing reservations and settlement entitlements |
| 7 | [DAO escrow and disposition](changes/arena-dao-escrow/proposal.md) | Requires lifecycle escrow and backing reservations; governance remains OPEN |
| 8 | [Bounded player agents](changes/arena-player-agents/proposal.md) | Coordinate player identity and deposit interface with lifecycle and backing |
| 9 | [MCP and terminal](changes/arena-mcp-terminal/proposal.md) | Requires player authorization and stable read/preview interfaces |
| 10 | [Testnet integrations and observability](changes/arena-testnet-integrations/proposal.md) | End-to-end acceptance depends on all implementation changes; research may run in parallel |

The [shared design](arena-design.md) preserves the cross-cutting data flow, trust boundaries and failure handling.

## Frontend, backend and agent integration plan

The [application integration master plan](plans/arena-application-integration/README.md)
maps the inspected 2026-11-10 source/working tree. It is a coordination plan, not
an executable fifth change or a live deployment claim. The former umbrella was
split before implementation; each change below has its own proposal, design,
capability spec and unchecked implementation tasks.

| Order | Application change | Dependencies |
| --- | --- | --- |
| 1 | [Application read API](changes/arena-application-read-api/proposal.md) | Safe contract views, audit archive and canonical read-model handoffs |
| 2a | [Market observations and charts](changes/arena-market-observations/proposal.md) | Shared read boundary; live modes gated by qualified providers |
| 2b | [Lifecycle frontend](changes/arena-lifecycle-frontend/proposal.md) | Shared read boundary plus verified lifecycle/backing/audit/custody capabilities |
| 3 | [Portfolio and payout frontend](changes/arena-portfolio-payout-frontend/proposal.md) | Shared reads; actions gated by settlement/backing/signing runtime evidence |

- [Current integration map](plans/arena-application-integration/integration-map.md): actual calls, exported ABI, runnable wiring and missing edges.
- [Reference design](plans/arena-application-integration/design.md) and [proposed API contracts](plans/arena-application-integration/api-contracts.md): cross-change architecture; endpoints are not implemented.
- [Ownership and handoffs](plans/arena-application-integration/ownership.md): one canonical task owner per responsibility, dependencies and release gates. Existing audit, contract, scheduler/indexer, signing, MCP and player-authorization tasks stay with their original owners.
- [Source crosscheck and apply gates](plans/arena-application-integration/crosscheck.md): feature mapping against inspected code, corrections and the deposit-only custody blocker. Ready artifacts do not mean all live actions are ready.

Market and lifecycle client work can proceed independently after shared DTOs
stabilize. Portfolio read-only work may start from API fixtures; financial actions
wait for their verified prerequisites. No application behavior changes in this split.

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
