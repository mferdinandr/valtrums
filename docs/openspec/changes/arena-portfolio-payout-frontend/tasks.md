## 1. Account reads

First read the [main reconciliation](../../plans/arena-application-integration/main-reconciliation.md). Reuse existing account-state/alert/gateway implementations and current DAO specs; verify remaining gaps before implementing snapshot tasks.

- [ ] 1.1 Extend shared read schemas/adapters and gateway with account positions, settlement progress, entitlements, reservations and payout status using exported views/events only.
- [ ] 1.2 Implement backend account/asset/status queries with bounded cursors, completeness/watermarks and explicit missing historical coverage.
- [ ] 1.3 Build lifecycle portfolio presentation separating eligible, reserved, delivered, late-fund and principal-held amounts by original asset; preserve a separate legacy adapter.

## 2. Wallet request UX

- [ ] 2.1 Implement reviewed payout request codecs for exact amounts, 32-byte IDs and 20-byte destinations with stable persisted request binding/recovery.
- [ ] 2.2 Add supported backing entitlement/representation and payout request wallet adapters, respecting caller custody attribution and independent asset identity.
- [ ] 2.3 Implement separately bound late-refund requests and capability-gated allocation/request controls using actual contract methods; keep settlement arithmetic in its owner.
- [ ] 2.4 Present all authoritative signing/broadcast/finality/reconciliation/restoration states; reconcile before retry and retain status reads when new requests are disabled.

## 3. Verification and release

- [ ] 3.1 Verify incomplete history, independent rewards/principal, integer codecs, beneficiary attribution and legacy isolation.
- [ ] 3.2 Verify reload/retry with stable IDs, timeout, revert, reconciliation-required and confirmed/restored updates without duplicate request creation or optimistic delivery.
- [ ] 3.3 Consume settlement/backing/signing-owner runtime evidence and verify eligible wallet requests on the configured deployment before enabling live payout capability; no signer/operator implementation or DAO release control in this change.
