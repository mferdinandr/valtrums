# Tasks

Check tasks only after implementation and verification. Backing reservations and settlement entitlements are prerequisites.

## Identity and constrained signing

- [x] Define a globally unambiguous payout identity including backing contract or asset identity and local reservation ID.
- [x] Have the payout contract itself call the NEAR MPC signer with the payload reconstructed from the reservation, and accept only the signature returned by the signer callback.
- [x] Persist the authorized reservation, destination binding, chain, token, amount, custody path, nonce and payload hash.
- [x] Reconstruct the permitted transaction from the reservation instead of trusting relayer-supplied parameters.
- [x] Reject changed recipient, token, amount, chain, path or nonce and reject infrastructure access to player spending.
- [x] Keep the entitlement exclusively reserved while signature or transaction execution is unresolved.

## Broadcast and reconciliation

- [x] Persist signature attempts, broadcast transaction hashes and replacement history under the same payout identity.
- [x] Reconcile pending transactions and replacements after restart or lost response before creating another spend.
- [x] Verify successful finalized receipt, sender, token, recipient and exact amount before confirming payment and consuming backing.
- [x] Distinguish signer response, broadcast, pending finality, revert, reconciliation-required and confirmed states.
- [x] Restore a liability only after proving no executable transaction or actual debit remains.

## Verification

- [x] Test two backing contracts issuing the same local payout ID without status or payload collision.
- [x] Test tampering, role misuse, duplicate requests and signer callback without a final receipt.
- [x] Test timeout, crash, same-transaction rebroadcast, replacement, revert and final receipt replay.
- [x] Test partial or mismatched transfer evidence remains unconfirmed and does not trigger a duplicate payment.

## Application runtime role follow-up

New runnable-process handoff scope; library/contract verification above remains unchanged. The [portfolio client](../arena-portfolio-payout-frontend/tasks.md) consumes request/status interfaces and does not implement these workers.

- [x] Wire durable eligible-request discovery and signature initiation into an explicitly configured runtime, reconciling existing attempts before retries; do not assume the current broadcast reconciler initiates signatures. `agent/src/payout-relayer.ts` (`pnpm -C agent payout:relayer`): reconciles first, then requests a signature only for an `authorized` payout with no attempt, the configured chain, a clear nonce slot and a reconciler clearance; eligibility lives in contract state, so a restart or lost response never allocates a second spend. Fixture-tested only (`agent/test/payout-roles.test.ts`).
- [x] Wire a separately authorized finalized-receipt confirmation operator with restart/reorg handling; keep its credentials out of the relayer, read service and client and preserve reservation-bound checks. `agent/src/payout-operator.ts` (`pnpm -C agent payout:operator`): own account/key/RPC, reconciles over a ledger that cannot write relayer methods, re-checks every proof against the contract view (`checkOperatorProof`) and submits `confirm_payout`/`record_revert`/`restore_payout` only with `PAYOUT_OPERATOR_SUBMIT=true` (dry run by default). Each role refuses to start if the other role's credentials or the arena agent key are present. Fixture-tested only.
- [ ] Record real testnet signature-to-final-confirmation and interruption/recovery evidence with the testnet integration owner before advertising live payout readiness; keep fixture proof separate.
