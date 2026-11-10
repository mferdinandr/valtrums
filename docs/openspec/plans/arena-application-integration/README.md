# Application integration master plan

Status: coordination/research plan, not an executable OpenSpec change. The former
`arena-frontend-agent-integration` umbrella has been split before implementation.
Do not apply or archive this plan as completed software. Canonical implementation
tasks and acceptance criteria live in the owning changes below.

## Why

The frontend still reads and signs the legacy A/B ABI, while lifecycle, backing,
round scoring, payout reconciliation and audit-report components exist on separate
source paths. The 3D arena and chart need one truthful application contract that
connects those components without treating fixtures, local observations or submitted
transactions as confirmed financial state.

## What Changes

- Introduce a versioned application integration boundary for battle discovery,
  contract reads, audit evidence, observation history, account positions, settlement,
  payouts and worker health. A same-origin Next.js gateway fronts read-only services;
  user signing stays in the wallet or an explicitly enforced player-action boundary.
- Keep `legacy-v1`, `lifecycle-v2` and fixture provenance distinct. Namespace every
  battle by network, arena contract, protocol and decimal-string ID; never reinterpret
  A/B economics as lifecycle economics or silently fall back to mock data.
- Integrate lifecycle reads and eligible wallet actions with the source ABI, including
  storage registration, receipt-backed representation, multi-community deposits,
  authoritative rounds and independent original-token payouts/principal escrow.
- Persist market observations before publication, expose bounded round-scoped chart
  queries, and separate provisional chart scores from contract-recorded resolution.
- Wire the existing audit archive, report reader, read-model indexer, custody-verifier
  and payout components through explicit process/role interfaces. Complete the missing
  lifecycle scheduler and provider integrations rather than claiming the legacy agent
  loop already drives them.
- Move list/search/dropdown filtering to backend queries with cursor pagination,
  300 ms debounced text search, cancellation and stale-response protection.
- Gate features on a validated deployment/capability manifest and per-service evidence;
  surface missing data, stale reads, pending receipts, reorgs and unsupported providers.
- **BREAKING, future opt-in:** lifecycle frontend DTOs, routes/action previews and
  normalized asset/position/payout models replace A/B assumptions in lifecycle mode.
  Existing legacy adapters/deployments remain separately supported; no automatic
  state conversion, activation, contract upgrade or database migration is included.

## Implementation changes and dependencies

| Order | Executable change | Scope / prerequisites |
| --- | --- | --- |
| 1 | [Application read API](../../changes/arena-application-read-api/proposal.md) | Namespace, capability DTOs, read service/gateway and backend search; no new financial mutations |
| 2a | [Market observations and charts](../../changes/arena-market-observations/proposal.md) | Durable collector/history + chart delivery; depends on read API; providers/scheduler remain integration-owner gates |
| 2b | [Lifecycle frontend](../../changes/arena-lifecycle-frontend/proposal.md) | Multi-community create/deposit/round UI; depends on read API and verified lifecycle/backing/audit/custody interfaces |
| 3 | [Portfolio and payout frontend](../../changes/arena-portfolio-payout-frontend/proposal.md) | Entitlements, payout requests/status and principal holds; depends on read API and owning financial contracts/workers |

After the shared API contracts stabilize, market and lifecycle client work can
proceed independently. Lifecycle financial release still waits for verified worker/
provider prerequisites. Portfolio read-only work can start against API fixtures;
its payout actions wait for verified backing/payout authority. The chart change is
not a prerequisite for contract-confirmed account reads.

Existing scoring, custody, audit, settlement, payout, DAO and player-authorization
requirements retain their original owners. [ownership.md](ownership.md) maps every
former umbrella task group to one canonical task list; there is no second master
checkbox list. Parent design/API files are reference architecture, not an obligation
for the first read-only change to implement all downstream endpoints.

## Impact

- Frontend: `web/src/components/providers.tsx`, `lib/arena/*`, `lib/terminal/*`,
  Arena/Create/Detail/Portfolio/Terminal routes, integrated 3D runtime and charts.
- Gateway: proposed `/api/arena/v1/*` reads and canonical preview/status surfaces;
  existing `/api/terminal/parse` and `/api/terminal/funding` remain separate existing routes.
- Agent: legacy `main.ts`/`runtime.ts`, market samplers, lifecycle audit/archive,
  indexer/read service, new lifecycle oracle/scheduler wiring and custody/payout workers.
- Contracts: consume existing lifecycle/round/backing/payout/receipt-registry ABI;
  missing versioned views/events need separate reviewed implementation/deployment work.
- Depends on [lifecycle](../../changes/arena-lifecycle/proposal.md), [audit](../../changes/arena-audit/proposal.md),
  [settlement](../../changes/arena-settlement/proposal.md), [backing](../../changes/arena-asset-representation/proposal.md),
  [payout](../../changes/arena-chain-signatures/proposal.md), [testnet integration](../../changes/arena-testnet-integrations/proposal.md)
  and archived [scoring requirements](../../specs/arena-scoring/spec.md).
  [MCP](../../changes/arena-mcp-terminal/proposal.md), [player agents](../../changes/arena-player-agents/proposal.md)
  and [DAO](../../changes/arena-dao-escrow/proposal.md) remain independent prerequisite gates for those features.

Status: proposed, source-inspected, not implemented or live-verified. The detailed
current-state inventory is [integration-map.md](integration-map.md).

The second [source crosscheck](crosscheck.md) records feature matches, corrections,
staged apply readiness and live release blockers. The [GitHub issue index](issues/README.md)
links nine published issues with inline scope/acceptance and dependencies because
these planning artifacts are still local until separately published. Issue creation
does not implement or deploy them.
