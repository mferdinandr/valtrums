# Payout identity, roles and reconciliation

`contracts/payout` is one shared payout contract for all backing instances. Its core is a pure state machine for a single original-token payout (`lib.rs`) wrapped by a NEAR contract (`contract.rs`) that stores payouts and calls the backing contracts.

## Roles

Fixed at initialization and required to be distinct accounts:

- **Holder** (an entitlement owner): the only one who can request a payout, and only from their own entitlement. The backing reserves it first, so an account without an entitlement is refused and no record is created.
- **Relayer**: calls `begin_signing`, `record_signature` and `record_broadcast`. It receives the exact authorized parameters, cannot choose them, and cannot confirm or release.
- **Operator**: the same trusted-operator model as deposits. It confirms payments, records reverts and supplies nonce-slot proofs for release. It cannot request payouts or sign. Relayer or operator may place a payout into reconciliation; neither can release it.
- **Owner**: registers a backing once (chain, token, custody domain, custody sender, path and first nonce). A registration can never change.

The backing contract accepts `reserve_payout`, `confirm_payout` and `release_payout` only from the single payout account fixed at its initialization.

## Behavior

- **Identity.** `PayoutId` is a SHA-256 over the length-prefixed backing account, holder and backing-local request id. `binding_hash` commits to the identity, chain, token, custody sender, destination, amount (in source atomic units, as returned by the reservation), path and nonce, but not gas pricing.
- **Signing.** A signature is accepted only with the matching binding hash and after a signing request was recorded. Same-nonce replacements must pay strictly more, at most eight attempts are kept, and every attempt stays recorded. A signature or broadcast never confirms.
- **Hold.** An unanswered signing request or unconfirmed broadcast moves the payout to `ReconciliationRequired`, which keeps the reservation and forbids a duplicate request.
- **Confirmation.** The operator's attested transfer must match chain, token, sender, recipient and exact amount and name one of our non-reverted attempts. The backing consumes its reservation first (exactly once, accepting a replacement hash the payout contract vouched for) and only then does the payout record `Confirmed`.
- **Release.** Without a signing request an operator can cancel; otherwise an attested finalized nonce slot must prove no spend remains (our attempt reverted, or a foreign transaction consumed the nonce). The backing returns the amount to the entitlement first, then the payout records `Restored`. A successful attempt must be confirmed, never released, and a confirmed or released reservation cannot take the other path.
- **Recovery.** A failed cross-contract call changes nothing and can be retried. Repeating an identical `request_payout` after a failure creates the missing record without reserving twice.

## Open work

Evidence is a trusted-operator attestation of finalized source-chain state, as for deposits, not a proof. Not done, so these tasks stay open:

- No MPC signer call and no transaction building: the relayer obtains the authorized payload and reports the signature and hashes. Nothing here reconciles pending transactions after a worker restart; an off-chain worker must do so using the operator interface.
- "Pending finality" is not a separate state; it is covered by `Broadcast` until the operator confirms or reports a revert.
- Source-chain nonce management is a counter per registered backing starting at the configured `first_nonce`. A released or foreign-consumed nonce leaves a gap that blocks later transactions from that sender until the custody account's nonce is resolved by the operator; this needs an operational procedure.
- The contract pays for later signing attempts from a 0.01 NEAR reserve kept out of each request deposit, and has no storage-management or owner withdrawal.
- Operator and relayer cannot be rotated. Holder-initiated cancellation and delegated (player-agent) requests are not supported.
- Only sandbox fixtures with synthetic operator evidence exist; there is no live Robinhood transfer.
