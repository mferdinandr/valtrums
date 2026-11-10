## 1. Collector and journal

- [ ] 1.1 Define namespace/round/mapping/policy-bound observation schema, exact inputs, nullable source times and evidence identities using shared read DTOs.
- [ ] 1.2 Implement explicitly configured chain/reference aliases with chain-aware address normalization; reject ambiguous/default mappings.
- [ ] 1.3 Implement durable append-before-publication journal, atomic manifest, deduplication, replay and explicit corruption/capacity handling without adding a database migration.
- [ ] 1.4 Integrate collector ingestion with frozen intervals and qualification outputs; retain missing boundaries, gaps and unsupported mode reasons.

## 2. Read and chart delivery

- [ ] 2.1 Extend read service/gateway with bounded round/community/time queries, cursors, revisions, watermarks and coverage metadata.
- [ ] 2.2 Implement provisional rational score projections only for qualified inputs; keep contract outcome references separate and gate unsupported modes.
- [ ] 2.3 Connect existing charts through protocol-specific adapters, including legacy snapshot/spot-versus-TWAP labels and explicit fixture isolation.
- [ ] 2.4 Add cancellable delta polling and revision reconciliation; preserve gaps and separate source cadence from display refresh and paused visuals.

## 3. Verification and handoff

- [ ] 3.1 Verify journal restart/conflict/deduplication, late retries, missing boundaries, source timestamps and namespace isolation.
- [ ] 3.2 Verify exact score display, incomplete coverage, legacy snapshots, retractions and stale/out-of-order chart responses without fabricated points or outcomes.
- [ ] 3.3 Publish persisted-evidence reader interface to the testnet-owned scheduler and consume its provider/live acceptance evidence before enabling each live chart mode; do not duplicate qualification or oracle runtime tasks here.
