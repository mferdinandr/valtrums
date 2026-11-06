## ADDED Requirements

### Requirement: Actual-received one-to-one backing
The system SHALL mint NEP-141 representations only against unique verified finalized actual Robinhood receipts with exact decimal normalization.

#### Scenario: Short receipt
- **WHEN** nominal input is 100 but custody actually receives 98
- **THEN** no more than 98 equivalent units are minted; tax admissibility remains a separate policy gate

#### Scenario: Receipt replay
- **WHEN** the same chain/transaction/log receipt is resubmitted
- **THEN** no new supply or position credit is created

#### Scenario: Decimal residue
- **WHEN** normalization leaves unrepresentable source units
- **THEN** they remain attributed unallocated custody and minting never rounds up

### Requirement: Exclusive backing reservation
The system SHALL conserve each asset using B = M + E + P + D + U as defined in docs/token-economics.md and prevent concurrent redemption, settlement payout and DAO disposal of the same units.

#### Scenario: Competing spends
- **WHEN** redemption and a disposal request target the same backing
- **THEN** at most one reservation succeeds

#### Scenario: Underlying debit already happened
- **WHEN** a callback is lost after an actual debit
- **THEN** representations are not restored merely due to timeout

#### Scenario: Reorg evidence
- **WHEN** a previously provisional source receipt is reorganized
- **THEN** the system cannot finalize minting from that receipt and reconciliation holds affected actions
