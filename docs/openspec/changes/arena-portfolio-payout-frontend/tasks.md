## 1. Account reads

First read the [main reconciliation](../../plans/arena-application-integration/main-reconciliation.md). Reuse existing account-state/alert/gateway implementations and current DAO specs; verify remaining gaps before implementing snapshot tasks.

- [ ] 1.1 Extend shared read schemas/adapters and gateway with account positions, settlement progress, entitlements, reservations and payout status using exported views/events only.
  - Delivered on `/portfolio` (#151): the page reads `inspect_account_state`, `inspect_positions`, `inspect_entitlements` and `inspect_payouts` through the existing gateway (`fetchReadTool`) with the wallet NEP-413 `ActionSession`. No new schema or backend read was added, so settlement progress and reservations are NOT covered and the task stays open.
- [ ] 1.2 Implement backend account/asset/status queries with bounded cursors, completeness/watermarks and explicit missing historical coverage.
  - Not done: the backend has no cursor-paginated account history (#144). The page shows the bounded-scan and "terminal payouts not listed" limitations and never claims "no payouts"; that is the client half only.
- [ ] 1.3 Build lifecycle portfolio presentation separating eligible, reserved, delivered, late-fund and principal-held amounts by original asset; preserve a separate legacy adapter.
  - Delivered: `web/src/app/portfolio/page.tsx` replaces the legacy A/B portfolio with separate sections (positions by original asset, per-account entitlement availability, backing entitlements and DAO principal, transfers by stage, late funds, recovery alerts). The page imports no legacy contexts, `@/lib/arena/*` or mocks. The legacy providers are untouched (removed elsewhere). Late funds/refunds render "not available from the read service yet" because no read reports them; that part of the task stays open.

## 2. Wallet request UX

- [x] 2.1 Implement reviewed payout request codecs for exact amounts, 32-byte IDs and 20-byte destinations with stable persisted request binding/recovery.
  - `web/src/lib/arena-read/portfolio.ts` (`validatePayoutDraft`, `buildPayoutReview`, `RequestIdStore`) with vitest coverage. Only the request id is persisted (localStorage, no authority); the id is bound to account, deployment, backing, amount and destination.
- [ ] 2.2 Add supported backing entitlement/representation and payout request wallet adapters, respecting caller custody attribution and independent asset identity.
  - The payout request wallet flow exists (`preview_action` -> compare with the reviewed call -> authorize -> sign -> verified receipt, via `useLifecycleCreate`). Entitlement/representation claim adapters are not built.
- [ ] 2.3 Implement separately bound late-refund requests and capability-gated allocation/request controls using actual contract methods; keep settlement arithmetic in its owner.
  - Not done: no exported late-refund read or method was verified.
- [ ] 2.4 Present all authoritative signing/broadcast/finality/reconciliation/restoration states; reconcile before retry and retain status reads when new requests are disabled.
  - Delivered for the states the read service reports (reserved, broadcast, confirmation pending, confirmed, reverted, restored); only confirmed is "paid". Reconcile-before-retry is a client gate (status must be read, no unresolved same-asset same-amount payout). Status reads stay usable when requests are disabled. Stays open: the payout list has no request id, so a reload cannot match a stored id to a specific payout record; the gate is therefore conservative (asset and amount).

## 3. Verification and release

- [ ] 3.1 Verify incomplete history, independent rewards/principal, integer codecs, beneficiary attribution and legacy isolation.
  - Verified in unit tests and a Brave e2e against FIXTURE data: incomplete history, integer/address/request-id codecs, separation of entitlement, transfer and principal. Beneficiary attribution is not applicable yet (no claim adapter).
- [ ] 3.2 Verify reload/retry with stable IDs, timeout, revert, reconciliation-required and confirmed/restored updates without duplicate request creation or optimistic delivery.
  - Stable id across reload and the state labels are unit-tested. The wallet flow itself (timeout, rejected wallet, revert) was NOT exercised in a browser: the e2e deployment has no wallet. Stays open.
- [ ] 3.3 Consume settlement/backing/signing-owner runtime evidence and verify eligible wallet requests on the configured deployment before enabling live payout capability; no signer/operator implementation or DAO release control in this change.
  - Blocked: spendable custody (#148) is not proven, so the page keeps payout requests disabled from the deployment custody capability and `/api/arena/v1/health` (`sourceTransfersEnabled`), with the specific reasons shown. No live payout was verified.

## Notes on what could not be verified

- No wallet session, account read or payout transaction ran against a live or fixture wallet; the Brave e2e covers the signed-out page (fixture alerts, disabled payout reasons, layout). The wallet-driven paths are covered only by pure-logic unit tests and type checking.
- `inspect_entitlements` reports that no deployed contract exposes per-account entitlements. The page shows that as "not available from the contract yet". The payout gate uses the per-backing `entitlement_of` values from `inspect_account_state`; whether the deployed backing contract exposes `entitlement_of` is not verified.
- `inspect_escrow` is not read by the page: it always reports `undecided` and defers to `inspect_account_state` for the D22 vote status and source-chain disposition, which the page shows without change.
