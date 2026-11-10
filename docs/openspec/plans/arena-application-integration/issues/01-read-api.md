## Outcome

Tracking: #143. Live read handoffs: #144 (views/indexer), #145 (audit archive). Downstream extensions: #146, #149, #151. Final cross-service acceptance: #80.

Introduce a read-only application service and same-origin Next.js gateway so frontend reads match the configured legacy or lifecycle deployment without fixture fallback.

## Scope

Canonical change: `arena-application-read-api`, all tasks. Inspect `web/src/lib/arena/near.ts`, `components/providers.tsx`, Arena fetch-all loop, agent report-server and indexer conventions.

- Validated deployment manifest, `(network, arenaContract, protocol, battleId)` identity and exact string integer codecs; reject unsafe numeric IDs.
- Battle/detail/asset/audit/health DTOs with provenance, freshness, watermark and explicit unavailable sections.
- Backend search/filter/cursors, default 20/max 100; asset dropdowns included. Clients debounce 300 ms, abort and reject stale responses.
- Allowlisted read gateway and audit archive consumer; no financial keys or mutation proxy.

## Acceptance

- Verify protocol collision, unsafe u64, query/cursor validation, stale response, missing archive and failed upstream cases.
- Recorded fixtures remain labeled; live capability requires verified ABI/deployment and live read-model evidence from the contract/indexer issue.
- No observation/account-action/canonical preview service is required to finish this foundation.

## Dependencies and delivery

Can start with schemas/recorded fixtures now. Audit producer and contract/indexer issues provide live handoffs. Use one focused branch/PR; leave implementation tasks unchecked until verified. No Playwright requested, no migrations/deployment/funds authorized.

Planning snapshot: local `feat/living-toy-world`, HEAD `4881fd76570a060659cafa7a4275e8740a5cdaf4` plus dirty tree, reviewed 2026-11-10. Split proposal/design/spec/tasks and `docs/openspec/plans/arena-application-integration/crosscheck.md` are local/uncommitted at issue creation: publish/reconcile those docs before applying the new change from another checkout. This issue records scope, not completed/live integration.
