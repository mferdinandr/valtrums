## 1. Shared read boundary

Before implementation, apply the [main reconciliation](../../plans/arena-application-integration/main-reconciliation.md): reuse existing MCP HTTP/search/session and Next gateway modules, verifying and refining tasks for remaining gaps instead of duplicating them.

- [x] 1.1 Define deployment manifest, protocol namespace, exact integer codecs and capability/provenance/error DTOs; verify unsafe u64 and fixture-isolation cases.
- [x] 1.2 Implement validated manifest loading and explicit legacy/lifecycle/fixture adapter selection without fallback on errors.
- [x] 1.3 Implement exported-ABI read adapters for supported battle/detail/readiness fields; report missing views rather than inventing them.

## 2. Read delivery and discovery

- [x] 2.1 Extend the existing separately runnable MCP/HTTP server with validated read-only v1 facades, bounded errors, health and no financial signing credentials.
- [x] 2.2 Add backend battle/asset search and cursor pagination over bounded projections, including stable ordering and preserved default 20/maximum 50 limits (reference ceiling 100).
- [x] 2.3 Add audit archive consumer adapter preserving report identity, TTL, reference-token label and missing/expired states; producer wiring remains in arena-audit.
- [x] 2.4 Add allowlisted same-origin Next.js read gateway without arbitrary forwarding or financial mutation routes.
- [x] 2.5 Add reusable query hooks with 300 ms text debounce, cancellation, namespace/generation checks and stale/degraded presentation.

## 3. Verification and handoff

- [x] 3.1 Verify namespace collision, unsafe numeric input, query validation, cursor stability, upstream failure, stale responses and absent archive cases using recorded fixtures.
- [x] 3.2 Document service configuration, storage bounds, dependency health and lifecycle/indexer/audit handoff requirements; distinguish recorded tests from live evidence.
- [ ] 3.3 Verify opted-in deployment reads against lifecycle-owned safe views and testnet-owned live indexer evidence before enabling live capabilities; publish DTO handoff to downstream changes.

Task 3.3 is a live release gate owned with #144/#145, not fixture proof. The shared
DTO and dependent handoffs are published in [handoff.md](handoff.md); canonical live
discovery remains disabled with a specific reason. #143 completes the independently
testable foundation without claiming this unavailable external evidence.
