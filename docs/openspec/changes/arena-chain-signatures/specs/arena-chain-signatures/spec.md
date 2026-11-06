## ADDED Requirements

### Requirement: Constrained reservation-bound signing
The signing policy SHALL reconstruct allowed chain, token, recipient, amount, custody path, nonce and payload from an exclusive authorized liability reservation.

#### Scenario: Tampered recipient
- **WHEN** a relayer changes a recipient or amount
- **THEN** signature authorization is rejected

#### Scenario: Infrastructure misuse
- **WHEN** an infrastructure credential requests arbitrary spending of a player's funds
- **THEN** the request is rejected

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
