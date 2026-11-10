## Outcome

Tracking: #144. Coordinate DTOs with #143; provide views/projections to #149 and #151. Event compatibility is also required by #147 and #150. Final cross-service acceptance: #80.

Supply the safe contract/view and canonical indexing handoffs needed by application reads and authoritative arena presentation.

## Scope

Canonical owners: new application compatibility follow-up in `arena-lifecycle`; live BlockSource/reducer follow-up in `arena-testnet-integrations`. Inspect arena `lib.rs`, `lifecycle.rs`, `rounds_api.rs`, `rounds.rs` and `agent/src/indexer/*`.

- Reuse existing `communities[].audit_expires_at_ms`; add only missing versioned activation/config/backing readiness and lossless discovery boundaries.
- Define reviewed history/window/exact-score/evidence views/events. Current round view has candidates/window/winner; old private history does not retain full scores/windows. Disclose backfill limits rather than inventing history.
- Wire a verified live BlockSource and explicit adapters for lifecycle/backing/payout event standards. Current reducer accepts only creation/audit/deposit and degrades on unknown relevant events.
- Preserve finalized cursors, replay/reorg handling, health, stable account/discovery projection and schema compatibility.

## Acceptance

- Reviewed ABI/spec deltas and serialization tests; prior records missing evidence remain incomplete.
- Replay/restart/reorg/unknown-event and live-source coverage evidence; fixture claims remain separate.
- Consumers receive documented DTO/event/version handoff. Do not mark financial confirmation correct merely because the indexer is healthy.

## Dependencies and delivery

Coordinate shared read DTOs first; contract work precedes dependent reducer rollout. Stage contract and indexer PRs if needed, keeping each owner canonical. Lifecycle activation cannot be applied to an account with legacy battles; deployment/upgrade/storage implications require explicit review. Cross-service acceptance stays in [#80](https://github.com/mferdinandr/valtrum/issues/80).

Local planning snapshot: `feat/living-toy-world` at `4881fd76570a060659cafa7a4275e8740a5cdaf4` plus dirty tree, 2026-11-10. Updated OpenSpec artifacts/crosscheck are uncommitted: publish/reconcile before apply elsewhere. No deployment, migration, funding or Playwright is authorized here; implement tests appropriate to contract/indexer behavior.
