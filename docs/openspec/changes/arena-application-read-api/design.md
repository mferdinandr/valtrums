## Context

The current web adapter uses a legacy contract and numeric battle IDs. Lifecycle views, audit reports and recorded indexer components exist separately; there is no general application HTTP backend. The [source inventory](../../plans/arena-application-integration/integration-map.md) records inspected behavior, not a deployed-system claim.

## Goals / Non-Goals

**Goals:** establish safe shared DTOs, read-only delivery, backend discovery/search and explicit capability/freshness handling.

**Non-Goals:** financial mutations, canonical action preview/auth services, new contract views, live indexer production, oracle/custody/signing workers or market collection. Account and observation endpoints are downstream extensions, not foundation completion criteria.

## Decisions

1. Use `(network, arenaContract, protocol, battleId)` as identity; deployment ID is an immutable configuration alias. IDs, amounts and nanosecond timestamps cross JSON as decimal strings. Reject unsafe bare numbers; coercing a rounded number to a string cannot recover its identity. Lifecycle owns any reviewed ABI/view changes required for safe discovery.
2. Add a separately runnable read-only Node service using the existing report-server conventions. A Next.js BFF validates parameters and forwards only to allowlisted upstreams, without signing keys or arbitrary URLs. Direct browser-to-worker access was rejected because it exposes topology and duplicates validation.
3. Use a validated deployment manifest and per-capability evidence. `legacy-v1`, `lifecycle-v2` and fixtures remain separate adapters. Missing configuration, unsupported RPC views and service failures produce explicit unavailable/degraded states, never automatic fixture fallback.
4. Query a backend read model with server-side filters, opaque stable cursors, default page size 20 and maximum 100. Searchable asset dropdowns use the same boundary. Clients debounce text by 300 ms, abort superseded requests and reject stale response generations. Do not fetch every contract page in the browser. Recorded fixtures can verify transport, but a live discovery claim requires the existing testnet indexer owner to supply canonical data.
5. Adapt the audit archive reader as a consumer; producer archive injection remains in the audit owner. Responses distinguish missing report, expired evidence, unsupported policy and failed provider. Reads do not grant admission. Every envelope carries deployment/protocol, origin, source block/receipt when available, fetched time, nullable observed time, watermark and health.

The [API reference](../../plans/arena-application-integration/api-contracts.md) describes the entire eventual system. This change implements only its manifest, battle/asset/audit and health reads. It does not implement its downstream preview, observation or payout surfaces.

## Risks / Trade-offs

- Incomplete lifecycle views → expose partial capabilities until lifecycle-owned versioned views and testnet-owned indexing are verified.
- File-backed read projections lack database scale → bounded storage and explicit overload/degraded states; future migration generation/application requires separate approvals.
- Cached admission appears current → preserve evidence expiry and never authorize custody/oracle/player actions from the cache.
- Role confusion → read service holds no custody, oracle, signer, confirmation-operator or player authority. Player authorization remains with existing MCP/player owners.

## Migration Plan

Release schemas and fixture-backed service tests first; verify configured deployment and live read model before opting a client into lifecycle reads. Roll back adapter selection explicitly without reinterpreting IDs or financial state. No contract activation, upgrade or database migration is part of this change.

## Open Questions

Final deployment IDs/addresses and readiness of versioned views require live verification. DAO policy and unresolved audit provider/live-change recovery decisions remain OPEN with their existing owners.
