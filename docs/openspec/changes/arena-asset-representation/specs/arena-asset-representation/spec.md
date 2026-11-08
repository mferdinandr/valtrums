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

#### Scenario: Unresolved spend
- **WHEN** a payout reservation cannot be matched to a finalized debit or a no-spend proof
- **THEN** the payout authority marks it unresolved, the asset stays suspended and the reservation is kept until a matching debit confirms it or a no-spend proof releases it

#### Scenario: Reorg evidence
- **WHEN** a previously provisional source receipt is reorganized
- **THEN** the system cannot finalize minting from that receipt and reconciliation holds affected actions

### Requirement: Custody deficit suspension
The system SHALL suspend minting, new reservations and payouts for an asset when an operator attestation at a finalized source block shows custody below liabilities, or on reorg or unresolved reconciliation, without erasing any liability.

#### Scenario: Deficit attestation
- **WHEN** the operator attests a custody balance below B (rounded up, plus attributed residue)
- **THEN** the asset is suspended, liabilities are unchanged and confirmations and no-spend releases still work

#### Scenario: Resume policy
- **WHEN** a suspension is caused by a deficit or reorg
- **THEN** `OwnerWithEvidence` (default) lets only the owner resume after a later covering attestation, `Automatic` lifts it on a later covering attestation, `Disabled` never resumes; only the owner changes the policy, with one yocto, and each change emits an event

### Requirement: Late foreign deposit refund
The system SHALL record a verified foreign deposit that arrives after a battle lock as unattributed to that battle and SHALL return it to the original depositor after finality, never crediting a snapshot or vault.

#### Scenario: Deposit after lock
- **WHEN** a finalized foreign receipt arrives after lock
- **THEN** no position or vault changes, and the amount is held as unattributed until it is refunded to the depositor

#### Scenario: Refund destination
- **WHEN** the refund is executed
- **THEN** it is reserved through the payout identity (`reserve_late_refund`) for the beneficiary named in the deposit event, only to the EVM refund address bound at deposit, and consumed once by `confirm_payout` or returned by `release_payout`

#### Scenario: Refund address binding
- **WHEN** a deposit names no refund address, or a refund targets another address
- **THEN** the deposit is rejected at the source or credits nothing, and the refund reservation fails

#### Scenario: Refund through payout
- **WHEN** the beneficiary or the payout operator requests a late refund for a beneficiary
- **THEN** only the bound address is reserved, signed for and confirmable; any other caller or address is rejected
