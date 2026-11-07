# Payout identity and reconciliation

`contracts/payout` is a new crate that will become one shared payout instance for all backing contracts. So far it contains only the pure state machine for a single original-token payout; it is not yet a NEAR contract, holds no storage, makes no cross-contract or signer calls, and no backing contract uses it.

- **Identity.** `PayoutId` is a SHA-256 over the length-prefixed backing account, holder and backing-local request id, so two backings issuing the same local id get different identities, payloads and statuses. `binding_hash` commits to the identity, chain, token, custody sender, destination, amount, custody path and nonce, but not gas pricing, so a same-nonce replacement keeps it.
- **Constrained signing.** An `Authorization` is built from a backing reservation, not from relayer parameters. A signature is accepted only with the matching binding hash and only after a signing request was recorded, so a changed recipient, token, amount, chain, path or nonce is refused. A signature or broadcast never confirms.
- **Reconciliation.** A requested signature whose response is lost, or an unconfirmed broadcast, moves to `ReconciliationRequired`, which keeps the reservation and forbids a duplicate request. Replacements reuse the nonce, must pay strictly more, and every attempt stays recorded.
- **Confirmation.** The attested transfer must equal the chain, token, sender, recipient and exact amount and name one of our non-reverted attempts, with a finalized head not below its block. Partial, mismatched or foreign transfers change nothing.
- **Restoration.** Without any signing request a payout can be cancelled. Otherwise release needs an attested finalized nonce slot for the custody sender: the nonce must have been consumed, either by one of our attempts that reverted or by a transaction we never produced. A successful attempt must be confirmed instead. Timeouts and lost responses never release.

Evidence here is a trusted-operator attestation of finalized source-chain state, as for deposits, not a proof. Open work, so the matching tasks stay unchecked:

- Contract wrapper, storage, and authentication of the signing requester, relayer and evidence submitter (role misuse and infrastructure access to player funds).
- Backing ABI to create a reservation for a payout, consume backing on confirmation and release it on restoration; `reserve_entitlement` and `confirm_redemption` remain Rust-only.
- NEAR MPC signature request and callback handling, transaction building from the authorization, and an operator or relayer that obtains the evidence.
- Distinguishing "pending finality" from "broadcast" as separate states.
