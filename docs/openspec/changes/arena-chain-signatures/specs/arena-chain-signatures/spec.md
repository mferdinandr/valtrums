## ADDED Requirements

### Requirement: Constrained reservation-bound signing
The signing policy SHALL reconstruct allowed chain, token, recipient, amount, custody path, nonce and payload from an exclusive authorized liability reservation.

#### Scenario: Tampered recipient
- **WHEN** a relayer changes a recipient or amount
- **THEN** signature authorization is rejected

#### Scenario: Infrastructure misuse
- **WHEN** an infrastructure credential requests arbitrary spending of a player's funds
- **THEN** the request is rejected

#### Scenario: Contract-initiated signing
- **WHEN** a payout is authorized from a reservation
- **THEN** the payout contract itself requests the MPC signature for the reconstructed payload and accepts only the signature returned by the signer callback, never one reported by a relayer

#### Scenario: Relayer supplies a signature
- **WHEN** a relayer or any account other than the contract itself tries to attach a signature to a payout
- **THEN** the call is rejected and the payout is unchanged

#### Scenario: Replacement and duplicates
- **WHEN** a signature is requested again for the same payout
- **THEN** it is accepted only with a strictly higher fee, at most eight attempts, and never for a second payout identity

### Requirement: Explicit payout states
The payout contract SHALL expose a stable status that distinguishes signing requested, signed, broadcast, pending finality, reverted, reconciliation required, confirmed and restored payouts.

#### Scenario: Lost signer callback
- **WHEN** the signer call fails or its answer is unusable
- **THEN** the payout is held as reconciliation required and its reservation stays

#### Scenario: Signature is not payment
- **WHEN** a payout is signed, broadcast or pending finality
- **THEN** it is not confirmed until matching finalized evidence is accepted

### Requirement: Final receipt confirmation
The system SHALL verify successful matching finalized execution before consuming backing as paid; a signature or broadcast alone SHALL NOT confirm a payout.

#### Scenario: Signer callback
- **WHEN** a valid signature arrives
- **THEN** the payout remains unconfirmed until matching execution evidence

#### Scenario: Restart
- **WHEN** a worker restarts with a pending transaction
- **THEN** it reconciles the durable payout and replacement history without paying twice

#### Scenario: Per-asset payout ID collision
- **WHEN** two backing contracts issue the same local payout ID
- **THEN** their payout identities, payloads, statuses and confirmations cannot overwrite each other
