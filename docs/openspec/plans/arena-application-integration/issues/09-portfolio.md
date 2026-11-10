## Outcome

Tracking: #151. Read client depends on #143 and account history handoff #144. Live financial actions depend on #148 custody and #150 payout runtime plus settlement/backing contracts. Does not depend on chart completion. Final acceptance: #80.

Integrate original-asset lifecycle account reads and reviewed payout request UX, keeping reward availability, reservations, delivery and principal hold distinct.

## Scope

Canonical change: `arena-portfolio-payout-frontend`, all tasks. Inspect current legacy portfolio/payout helpers, arena settlement API, backing views and payout `PayoutView`.

- Account/asset/status backend search and bounded cursor queries, settlement/account read gateway extensions and explicit history completeness.
- Use actual exported `get_settlement_progress` and account views; `settlement_plan` is internal and `list_open_payouts` is not full account history.
- Separate entitlements, reserved/in-flight amounts, confirmed transfers, late funds and held principal by original asset. Preserve separate legacy adapter.
- Reviewed exact integer/32-byte ID/20-byte destination codecs, stable request recovery and separately bound late refunds. Caller-attributed custody is not authority over another account.
- Distinguish all authoritative payout states; reconcile before retry. Disable new requests while retaining status visibility if worker capability fails.

## Acceptance

Verify incomplete history, asset isolation, held principal/independent rewards, reload/retry, timeout/revert/reconciliation/confirmed/restored states without double submission or optimistic delivery. No DAO release controls while governance remains OPEN in local specs.

## Dependencies and delivery

Read-only UI can start after shared read DTOs. Live actions require settlement/backing, account indexing, **spendable custody** and signature/operator runtime evidence. Contract allocation arithmetic and workers remain their existing owners. Cross-service acceptance stays [#80](https://github.com/mferdinandr/valtrum/issues/80).

Snapshot: local `feat/living-toy-world`, HEAD `4881fd76570a060659cafa7a4275e8740a5cdaf4` plus dirty tree, 2026-11-10. Split OpenSpec docs/crosscheck are uncommitted; publish/reconcile before apply elsewhere. No Playwright, migrations, deployment or funds authorized by issue creation.
