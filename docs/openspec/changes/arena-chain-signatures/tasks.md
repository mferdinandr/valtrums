# Tasks

Check tasks only after implementation and verification. Backing reservations and settlement entitlements are prerequisites.

## Identity and constrained signing

- [x] Define a globally unambiguous payout identity including backing contract or asset identity and local reservation ID.
- [ ] Persist the authorized reservation, destination binding, chain, token, amount, custody path, nonce and payload hash.
- [ ] Reconstruct the permitted transaction from the reservation instead of trusting relayer-supplied parameters.
- [ ] Reject changed recipient, token, amount, chain, path or nonce and reject infrastructure access to player spending.
- [ ] Keep the entitlement exclusively reserved while signature or transaction execution is unresolved.

## Broadcast and reconciliation

- [ ] Persist signature attempts, broadcast transaction hashes and replacement history under the same payout identity.
- [ ] Reconcile pending transactions and replacements after restart or lost response before creating another spend.
- [ ] Verify successful finalized receipt, sender, token, recipient and exact amount before confirming payment and consuming backing.
- [ ] Distinguish signer response, broadcast, pending finality, revert, reconciliation-required and confirmed states.
- [ ] Restore a liability only after proving no executable transaction or actual debit remains.

## Verification

- [x] Test two backing contracts issuing the same local payout ID without status or payload collision.
- [ ] Test tampering, role misuse, duplicate requests and signer callback without a final receipt.
- [x] Test timeout, crash, same-transaction rebroadcast, replacement, revert and final receipt replay.
- [x] Test partial or mismatched transfer evidence remains unconfirmed and does not trigger a duplicate payment.
