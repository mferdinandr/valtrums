## Outcome

Tracking: #145. Producer handoff for #143 audit reads and #149 lifecycle readiness. Can proceed independently of chart/payout work. Final cross-service acceptance: #80.

Make actual lifecycle audit reports appear durably in the existing passive report reader.

## Scope

Canonical owner: `arena-audit` application integration producer follow-up. `agent/src/audit/lifecycle-pass.ts` supports an optional archive sink, while `main.ts` currently injects only `AuditReportStore` in memory. Report archive/query/server/CLI already exist: extend their conventions rather than rebuilding them.

- Inject configured durable archive, trusted arena namespace and explicit provenance into the runnable audit process.
- Share the exact archive location/format with the passive report service.
- Surface archive failure/retry/capacity/health without falsely claiming current audit approval.
- Preserve reference-token labeling, evidence/policy IDs, per-field reasons and TTL.

## Acceptance

- Real process configuration writes an attributed record recoverable through the report reader after restart.
- Sink failure/retry and historical/current freshness are verified; demo seeds cannot satisfy live publication evidence.
- Publish consumer handoff to the read API issue. Provider qualification remains in existing audit/testnet tasks, not this wiring task.

## Delivery

One focused producer PR; do not reset historical completed library tasks. Fixture verification and live evidence are separate. Global acceptance remains [#80](https://github.com/mferdinandr/valtrum/issues/80).

Reviewed local snapshot 2026-11-10: `feat/living-toy-world`, HEAD `4881fd76570a060659cafa7a4275e8740a5cdaf4` plus dirty tree. The follow-up spec/task and integration crosscheck are currently uncommitted and require publication/reconciliation before apply in another checkout. No secret logging, migrations, deployment/funding or Playwright requested.
