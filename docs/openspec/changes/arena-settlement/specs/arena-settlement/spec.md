## ADDED Requirements

### Requirement: Per-token rewards and revenue
For each losing vault the system SHALL allocate the remainder after its snapshotted configurable fee to final-winner participants proportionally. Each battle SHALL snapshot fee, split and protocol recipient at creation, and a protocol-created battle SHALL allocate its entire fee to protocol.

#### Scenario: Fee settings and defaults
- **WHEN** protocol configures fees
- **THEN** only protocol can change them, total fee is 0 through 1000 basis points (a 10% ceiling) and creator share is 0 through 10000, independently
- **AND** initial defaults are fee 10 bps (0.1%) and creator share 5000 bps (50% of fee)

#### Scenario: Configuration changes
- **WHEN** protocol changes fee or split after battle creation
- **THEN** the battle retains its snapshot and new battles use the new values

#### Scenario: Invalid bounds and zero shares
- **WHEN** total fee is outside 0 through 1000 basis points or creator share is outside 0 through 10000
- **THEN** configuration is rejected; valid zero recipient allocations do not fail other allocations

#### Scenario: Two communities
- **WHEN** A wins over a vault of 100000 B units with 60/40 player weights and default settings
- **THEN** players receive 59940 and 39960 B; creator/protocol receive 50 each

#### Scenario: Three communities
- **WHEN** A wins over B and C
- **THEN** both losing tokens have separate allocations, including any vault eliminated in overtime

#### Scenario: Protocol creator
- **WHEN** the protocol created and actually staked in a battle with 100000 losing units and default settings
- **THEN** winners receive 99900 and protocol receives 100 with no extra creator fee

#### Scenario: Community joined after creation
- **WHEN** a losing community joined an open arena after it was created
- **THEN** its vault uses the fee and creator share snapshotted at creation, the same as every other community (D38)

#### Scenario: Cancelled or empty
- **WHEN** a battle is cancelled before lock, or a community had an empty vault at lock
- **THEN** no allocation, fee or entitlement exists for it; a cancelled battle's depositors take refunds instead

### Requirement: Deterministic conserving rounding
The system SHALL first collect `fee = floor(loser_vault * fee_bps / 10000)` using checked wide arithmetic and assign `loser_vault - fee` to the winner pool. Largest remainder SHALL apply only within the winner pool with stable beneficiary tie ordering, independent of claim order.

#### Scenario: Fee split
- **WHEN** a fee is allocated
- **THEN** a user-created battle gives `floor(fee * creator_share_bps / 10000)` to the creator and the remainder to protocol, and a protocol-created battle gives all of the fee to protocol
- **AND** the numeric examples below use default fee settings

#### Scenario: Uneven vault
- **WHEN** a user-created losing vault holds 10003 units
- **THEN** reward, creator and protocol allocations are 9993, 5 and 5

#### Scenario: Uneven winner weights
- **WHEN** reward pool 9993 is shared in weights 1:2:3 with canonical beneficiary order Alice, Bob, Carol
- **THEN** allocations are 1666, 3331 and 4996

#### Scenario: Tiny vault
- **WHEN** a losing vault holds 999 base units
- **THEN** the winner pool is 999 and total fee is zero for either creator type

#### Scenario: Odd fee split
- **WHEN** a user-created losing vault holds 1000 base units
- **THEN** total fee is 1, winner pool is 999, creator receives 0 and protocol receives 1

#### Scenario: Protocol receives the entire odd fee
- **WHEN** a protocol-created losing vault holds 1000 base units
- **THEN** winner pool is 999 and protocol receives the entire fee of 1

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

### Requirement: Per-token entitlement states
The read model SHALL report, per losing token and holder, available, reserved, broadcast, confirmation-pending and confirmed amounts that sum to the entitlement. Only confirmed counts as paid; a signature, broadcast or hash never does.

#### Scenario: States sum to the entitlement
- **WHEN** a holder is entitled to 100 and 60 is reserved for a payout
- **THEN** available is 40, reserved is 60 and the states sum to 100

#### Scenario: Broadcast is not payment
- **WHEN** a payout is signed, broadcast or pending finality
- **THEN** confirmed stays 0 until the payout authority records a verified final debit

