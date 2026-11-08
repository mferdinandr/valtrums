# Payout identity, roles, signing and states

`contracts/payout` is one shared payout contract for all backing instances. Its core is a pure state machine for a single original-token payout (`lib.rs`), an EIP-1559 transaction builder and signer-response parser (`evm.rs`), and a NEAR contract (`contract.rs`) that stores payouts, calls the MPC signer and calls the backing contracts.

## Stable payout status interface

Consumers (restart reconciliation, settlement, MCP) read payouts only through these views. Variants and fields are only ever added, never renamed, reordered or removed.

```text
get_payout(backing: AccountId, holder: AccountId, request_id: [u8; 32]) -> Option<PayoutView>
get_payout_status(backing, holder, request_id) -> Option<String>   // the `state` label only
list_open_payouts(from_index: U64, limit: U64) -> PayoutPage       // non-terminal payouts, creation order, limit capped at 50
get_payout_count() -> U64
get_signed_transaction(backing, holder, request_id, tx_hash) -> Option<String>  // hex of 0x02 || rlp, ready for eth_sendRawTransaction
get_signing_payload(backing, holder, request_id) -> Option<SigningPayload>
get_signer() -> AccountId
```

`PayoutView` (JSON): `backing`, `holder`, `request_id`, `state`, `reason` (null unless `reconciliation_required`), `terminal`, `chain_id` (U64 string), `token`, `sender`, `destination` (byte arrays of 20), `amount` (U128 string), `path`, `nonce` (U64 string), `binding_hash`, `attempts: [{tx_hash, max_fee_per_gas, state}]` (oldest first; `tx_hash` is all zero while an attempt is `requested`), `evidence_hash` (null unless `confirmed`). TypeScript types: `agent/src/payout-status.ts`.

`state` is one of (snake_case strings):

| state | meaning | next states |
| --- | --- | --- |
| `authorized` | reserved in the backing; nothing asked from the signer | `signing_requested`, `restored` (operator cancel, no proof) |
| `signing_requested` | the contract called the signer and the callback has not run; a signature may exist | `signed`, `reconciliation_required` |
| `signed` | the signer answered; a signed transaction is stored; nothing known on the network | `broadcast`, `signing_requested` (replacement), `reconciliation_required`, `confirmed`, `restored`, `reverted` |
| `broadcast` | the relayer reported sending an attempt | `pending_finality`, `signing_requested`, `reconciliation_required`, `confirmed`, `reverted`, `restored` |
| `pending_finality` | an attempt was seen on the network, not final | as `broadcast` |
| `reverted` | every attempt finalized with failure, no new spend possible | `restored` (nonce-slot proof) |
| `reconciliation_required` | unresolved, reservation held, `reason` is `SignerNoResponse`, `BroadcastUnconfirmed` or `EvidenceUnavailable` | any non-terminal state a late signature or evidence proves, or `restored` with proof |
| `confirmed` | terminal: matching finalized transfer attested and the backing consumed its reservation | none |
| `restored` | terminal: no executable spend remains and the backing returned the amount to the entitlement | none |

`signed`, `broadcast` and `pending_finality` never confirm a payout. A late signature never moves a payout back from `broadcast` or `pending_finality` to `signed`. `terminal` is true only for `confirmed` and `restored`. The `reason` strings keep the Rust variant names (also the argument of `require_reconciliation`).

Events (NEP-297, standard `valtrum_payout`, version `1.0.0`, `EVENT_JSON:` log prefix), all with `backing`, `holder` and `request_id` (hex) in `data`:

- `signature_requested`: `payload_hash`, `max_fee_per_gas`, `nonce`.
- `signature_received`: `tx_hash`, `max_fee_per_gas` (a signed attempt was stored).
- `signature_failed`: `max_fee_per_gas` (call failed or answer unusable; payout held).
- `payout_state_changed`: `from` (null for a new payout), `to`, `reason`. Emitted on every change of the public `state`, including creation.

## Roles

Fixed at initialization and required to be distinct accounts (`new(owner, operator, relayer, signer)`):

- **Holder** (an entitlement owner): the only one who can request a payout, and only from their own entitlement. The backing reserves it first, so an account without an entitlement is refused and no record is created.
- **Relayer**: calls `request_signature` (chooses only a fee cap), `record_broadcast`, and may report a sighting or place a payout on hold. It cannot choose recipient, amount, token, chain, path or nonce, cannot supply a signature, and cannot confirm or release.
- **Operator**: confirms payments, records reverts and supplies nonce-slot proofs for release. It cannot request payouts or signatures.
- **Signer**: the MPC signer account fixed at initialization. Only the contract's own private callback `on_signature`, reached by the promise the contract created, can attach a signature. The signer account has no privileged method.
- **Owner**: registers a backing once (chain, token, custody domain, custody sender, path, first nonce, gas limit, fee cap). A registration can never change.

The backing contract accepts `reserve_payout`, `confirm_payout` and `release_payout` only from the single payout account fixed at its initialization.

## Behavior

- **Identity.** `PayoutId` is a SHA-256 over the length-prefixed backing account, holder and backing-local request id. `binding_hash` commits to the identity, chain, token, custody sender, destination, amount (source atomic units from the reservation), path and nonce, but not gas pricing.
- **Signing (contract-initiated).** `request_signature` is relayer-only with one yocto. The contract rebuilds the transaction from the stored authorization: EIP-1559 type 2, zero value, empty access list, `to` the registered token, calldata `transfer(destination, amount)` (selector `a9059cbb`), the reserved nonce, the registered gas limit, and a priority fee equal to the fee cap. The relayer only supplies the fee cap, which must be at most the registered cap and strictly higher than every earlier attempt. Extra arguments are ignored. The request is recorded (state `signing_requested`) before the cross-contract call to the configured signer. The signer deposit (1 yoctoNEAR) and the attempt storage come from the contract's own balance, which each request funds with a 0.01 NEAR reserve.
- **Signature intake.** `on_signature` is private. It parses the signer response, rebuilds the signed transaction from the stored request, derives the transaction hash itself and stores signature and hash under the attempt. An unusable response or a failed call removes the empty request and holds the payout in `reconciliation_required` (`SignerNoResponse`); a late answer is still recorded. The signature is not verified on chain against the custody address (see open work).
- **Replacement.** Same nonce, strictly higher fee, at most eight attempts, every attempt stays recorded, one unanswered request at a time unless the payout is on hold. Repeating `request_payout` is idempotent per payout identity.
- **Hold.** An unanswered signing request or unconfirmed broadcast can be placed in `reconciliation_required`, which keeps the reservation and forbids release without proof.
- **Confirmation.** The operator's attested transfer must match chain, token, sender, recipient and exact amount and name one of our non-reverted attempts. The backing consumes its reservation first (exactly once) and only then does the payout record `confirmed`.
- **Release.** Without a signing request an operator can cancel; otherwise an attested finalized nonce slot must prove no spend remains. The backing returns the amount first, then the payout records `restored`. A successful attempt must be confirmed, never released.
- **Recovery.** A failed cross-contract call changes nothing and can be retried.

## Signer interface (NEAR Chain Signatures)

The contract calls `sign` on the configured signer with `{"request": {"path": <registered path>, "payload_v2": {"Ecdsa": <64 hex chars, the transaction signing hash>}, "domain_id": 0}}`, one yoctoNEAR attached, 250 Tgas, and a callback with 20 Tgas. Sources: the near/mpc contract README (`crates/contract/README.md`) states the `request` fields `path`, `payload_v2` (`{"Ecdsa": hex of 32 bytes}`), `domain_id`, a required deposit of at least 1 yoctonear (excess refunded) and a `Secp256k1` response carrying `big_r`, `s` and `recovery_id` (r is the x coordinate of `big_r`, s is low-s normalized). docs.near.org lists the signer accounts `v1.signer` (mainnet) and `v1.signer-prod.testnet` (testnet). The signer derives the custody key from the calling account and `path`, so a custody address derived for this contract is reachable only through it. `contracts/mock-mpc` is a sandbox fixture with the same shape and deliberately invalid signatures; tests with it are not live signer evidence.

Not verified against the official documentation or a live signer: the gas to attach (250 Tgas is a conservative choice), the value of `domain_id` for secp256k1 on testnet (0 is assumed), the exact serialized response of the deployed testnet signer (the parser accepts the tagged and untagged forms and the `affine_point` and `scalar` wrappers), and the current testnet fee. The signer account is only configured at initialization.

## Restart reconciliation worker

`agent/src/payout-reconciler.ts` (`PayoutReconciler.reconcile()`) runs before every agent pass when `PAYOUT_RECONCILE_ENABLED=true` (`PAYOUT_CONTRACT_ID`, `PAYOUT_EVM_RPC_URL` https, optional `PAYOUT_OPERATOR_ACCOUNT_ID` and `PAYOUT_OPERATOR_PRIVATE_KEY`, `PAYOUT_SIGNING_GRACE_SECS` default 300). The agent account acts as the relayer; the operator methods are only called when an operator key is configured, otherwise the outcome is `needs_operator`. It reads `list_open_payouts` (all pages), the node's `finalized` block and each attempt's receipt, then decides per payout:

| Chain shows | Worker does |
| --- | --- |
| nothing signed, state `authorized` | nothing; spend gate open |
| `signing_requested` with no hash | wait; hold as `SignerNoResponse` after the grace period (kept in memory, so a restart restarts the wait) |
| success receipt, not finalized | `record_broadcast` and `record_pending_finality` as needed |
| success receipt, finalized, canonical block, exact Transfer log (token, sender, recipient, amount) | operator `confirm_payout` with evidence (log index, block hash, finalized head, `evidence_hash` = keccak256 of chain, tx hash, block hash, log index, token, sender, recipient, amount) |
| success receipt, finalized, no exact matching log or non-canonical block | `require_reconciliation(EvidenceUnavailable)`; never confirm, never pay again |
| revert receipt, finalized | operator `record_revert`; then, once the finalized nonce exceeds the payout nonce and no request is outstanding, operator `restore_payout` with an `OurTxReverted` proof |
| known to the node (mempool), no receipt | `record_broadcast`/`record_pending_finality` as needed |
| unknown to the node, nonce unused | send the identical stored signed bytes again (verified against the hash, chain, token, recipient, amount, nonce, zero value), then `record_broadcast` |
| unknown to the node, nonce used, no attempt receipt | `require_reconciliation(EvidenceUnavailable)`; the consuming transaction hash is needed for a `ForeignTx` proof, which the worker does not build |

`spendAllowed(backing, holder, requestId)` is true only after a complete pass and only for a payout that was `authorized` with no attempt; every other outcome, error, chain id mismatch or unavailable finalized head keeps it false. Spend-creating code (a future relayer worker) must check it. Not covered: a replacement signature requested after a hold is outside this worker; `get_signed_transaction` is trusted only after the hash check. Tests use an in-memory chain and ledger (fixtures), not a live node or the deployed contract.

## Nonce gaps (operational procedure, not a protocol rule)

Nonces are a counter per registered backing starting at `first_nonce`. A payout that is released, never broadcast, or whose nonce a foreign transaction consumed leaves a gap, and later transactions from the same custody sender stay queued behind it. Procedure for the operator: (1) read the custody sender's confirmed transaction count on the source chain and compare it with the lowest open nonce from `list_open_payouts`; (2) if the nonce below an open payout is unused and has no pending transaction, do not invent a new rule: decide with the owner whether to fund and sign a no-op (self-transfer) for that nonce through a separate reviewed path, or to wait; (3) record the proof for any released payout (`restore_payout`); (4) never reuse a nonce for a different recipient. The contract does not create no-op transactions and does not renumber nonces.

## Open work

Evidence is a trusted-operator attestation of finalized source-chain state, as for deposits, not a proof. Not done:

- `pending_finality` is entered by an explicit report from the relayer or operator (`record_pending_finality`), not detected by the contract.
- The returned signature is not checked on chain against the custody address (for example with `ecrecover`); a wrong signature would only produce a transaction the chain rejects. Recommended hardening, not done because the mock signer returns invalid signatures.
- The contract has no storage-management or owner withdrawal, and its 0.01 NEAR per-payout reserve is not tracked as a balance.
- Operator and relayer cannot be rotated. Holder-initiated cancellation and delegated (player-agent) requests are not supported.
- Only sandbox fixtures with synthetic operator evidence exist; there is no live signer or Robinhood transfer. The payout path must not be deployed or funded on that basis.
