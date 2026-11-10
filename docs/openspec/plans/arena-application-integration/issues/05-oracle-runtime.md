## Outcome

Tracking: #147. Consumes #146 persisted-evidence interface and coordinates contract/projection handoff with #144. Provider qualification can start independently; runtime integration follows those interfaces. Enables authoritative rounds for #149. Final acceptance: #80.

Wire a separately authorized lifecycle oracle scheduler that consumes persisted frozen-round evidence and reports honest mode readiness.

## Scope

Canonical owner: `arena-testnet-integrations` provider tasks and application runtime scheduler follow-up. Inspect `agent/src/main.ts`, market wiring and arena `rounds_api.rs`.

- Current main loop is legacy; implement lifecycle start/open/submit orchestration with exact exported ABI, frozen terms digest, required storage/one-yocto and oracle authorization.
- Dedicated role/config, deterministic round identity, idempotent restart reconciliation and recorded intervals; late retries do not shift close.
- Consume market journal reader; fresh overtime evidence for tied candidates only. Missing evidence stays pending.
- Qualify price/drawdown and other modes separately. Refuse live cap/volume without required supply/exact interval coverage; scripted modes remain explicitly test-only.
- Publish per-round status/provider/coverage/freshness to application health without exposing signing credentials.

## Acceptance

Recorded/fake-source tests cover tie, missing input, duplicate submit, restart and late evidence. Actual live readiness requires independently recorded provider and testnet-round evidence, not fixtures. Deposit-only custody does not need to be funded to test read/recorded scheduler behavior.

## Dependencies and delivery

Depends on frozen policy/ABI handoff and persisted evidence. Replaces no scoring rules. Historical [#134](https://github.com/mferdinandr/valtrum/issues/134) was closed `NOT_PLANNED`; it is context, not completion evidence. Cross-service acceptance remains [#80](https://github.com/mferdinandr/valtrum/issues/80).

Local review 2026-11-10: `feat/living-toy-world`, HEAD `4881fd76570a060659cafa7a4275e8740a5cdaf4` plus dirty tree. Follow-up specs/tasks and crosscheck are uncommitted: publish/reconcile before apply elsewhere. No deployment, funding, migrations or Playwright authorized; preserve oracle/custody/signer/operator/player role separation.
