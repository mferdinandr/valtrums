## ADDED Requirements

### Requirement: Per-token rewards and revenue
For each losing vault the system SHALL allocate 99.9% to final-winner participants proportional to locked winning-token units, 0.05% to creator and 0.05% to protocol. A protocol-created battle SHALL allocate the entire 0.1% fee to protocol.

#### Scenario: Two communities
- **WHEN** A wins over a vault of 100000 B units with 60/40 player weights
- **THEN** players receive 59940 and 39960 B; creator/protocol receive 50 each

#### Scenario: Three communities
- **WHEN** A wins over B and C
- **THEN** both losing tokens have separate allocations, including any vault eliminated in overtime

#### Scenario: Protocol creator
- **WHEN** the protocol created and actually staked in a battle with 100000 losing units
- **THEN** winners receive 99900 and protocol receives 100 with no extra creator fee

### Requirement: Deterministic conserving rounding
The system SHALL apply the category and beneficiary largest-remainder algorithm and stable tie ordering in docs/token-economics.md independent of claim order.

#### Scenario: Uneven vault
- **WHEN** a user-created losing vault holds 10003 units
- **THEN** reward, creator and protocol allocations are 9993, 5 and 5

#### Scenario: Uneven winner weights
- **WHEN** reward pool 9993 is shared in weights 1:2:3 with canonical beneficiary order Alice, Bob, Carol
- **THEN** allocations are 1666, 3331 and 4996

#### Scenario: Tiny vault
- **WHEN** fees are smaller than one base unit
- **THEN** integer allocation conserves the vault without inventing a dust fee

### Requirement: Original-token asynchronous payout
Rewards SHALL remain each original losing token on Robinhood. The system SHALL distinguish available entitlement from reserved, broadcast and confirmed payment, without waiting for DAO disposition.

#### Scenario: Unresolved DAO
- **WHEN** principal remains escrowed and losing-token payout is otherwise valid
- **THEN** reward payout can proceed

#### Scenario: Lost response and retry
- **WHEN** broadcast succeeded but a response is lost
- **THEN** the same payout identity and nonce are reconciled before another spend; allocation and fee are not repeated

#### Scenario: One token fails
- **WHEN** B payout confirms while C payout is pending
- **THEN** B remains confirmed and C remains independently owed
