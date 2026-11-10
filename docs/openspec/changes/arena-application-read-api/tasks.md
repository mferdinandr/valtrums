## 1. Shared read boundary

Before implementation, apply the [main reconciliation](../../plans/arena-application-integration/main-reconciliation.md): reuse existing MCP HTTP/search/session and Next gateway modules, verifying and refining tasks for remaining gaps instead of duplicating them.

- [ ] 1.1 Define deployment manifest, protocol namespace, exact integer codecs and capability/provenance/error DTOs; verify unsafe u64 and fixture-isolation cases.
- [ ] 1.2 Implement validated manifest loading and explicit legacy/lifecycle/fixture adapter selection without fallback on errors.
- [ ] 1.3 Implement exported-ABI read adapters for supported battle/detail/readiness fields; report missing views rather than inventing them.

## 2. Read delivery and discovery

- [ ] 2.1 Implement separately runnable read-only server with validated parameters, bounded errors, health and no signing credentials.
- [ ] 2.2 Add backend battle/asset search and cursor pagination over the read model, including stable ordering and default 20/maximum 100 limits.
- [ ] 2.3 Add audit archive consumer adapter preserving report identity, TTL, reference-token label and missing/expired states; producer wiring remains in arena-audit.
- [ ] 2.4 Add allowlisted same-origin Next.js read gateway without arbitrary forwarding or financial mutation routes.
- [ ] 2.5 Add reusable query hooks with 300 ms text debounce, cancellation, namespace/generation checks and stale/degraded presentation.

## 3. Verification and handoff

- [ ] 3.1 Verify namespace collision, unsafe numeric input, query validation, cursor stability, upstream failure, stale responses and absent archive cases using recorded fixtures.
- [ ] 3.2 Document service configuration, storage bounds, dependency health and lifecycle/indexer/audit handoff requirements; distinguish recorded tests from live evidence.
- [ ] 3.3 Verify opted-in deployment reads against lifecycle-owned safe views and testnet-owned live indexer evidence before enabling live capabilities; publish DTO handoff to downstream changes.
