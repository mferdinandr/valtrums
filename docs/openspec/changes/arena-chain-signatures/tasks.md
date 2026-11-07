# Tasks

Check tasks only after implementation and verification. Backing reservations and settlement entitlements are prerequisites.

## Identity and constrained signing

- [x] Define a globally unambiguous payout identity including backing contract or asset identity and local reservation ID.
- [ ] Have the payout contract itself call the NEAR MPC signer with the payload reconstructed from the reservation, and accept only the signature returned by the signer callback.
- [x] Persist the authorized reservation, destination binding, chain, token, amount, custody path, nonce and payload hash.
- [x] Reconstruct the permitted transaction from the reservation instead of trusting relayer-supplied parameters.
- [x] Reject changed recipient, token, amount, chain, path or nonce and reject infrastructure access to player spending.
- [x] Keep the entitlement exclusively reserved while signature or transaction execution is unresolved.

## Broadcast and reconciliation

- [x] Persist signature attempts, broadcast transaction hashes and replacement history under the same payout identity.
- [ ] Reconcile pending transactions and replacements after restart or lost response before creating another spend.
- [x] Verify successful finalized receipt, sender, token, recipient and exact amount before confirming payment and consuming backing.
- [ ] Distinguish signer response, broadcast, pending finality, revert, reconciliation-required and confirmed states.
- [x] Restore a liability only after proving no executable transaction or actual debit remains.

## Verification

- [x] Test two backing contracts issuing the same local payout ID without status or payload collision.
- [x] Test tampering, role misuse, duplicate requests and signer callback without a final receipt.
- [x] Test timeout, crash, same-transaction rebroadcast, replacement, revert and final receipt replay.
- [x] Test partial or mismatched transfer evidence remains unconfirmed and does not trigger a duplicate payment.
