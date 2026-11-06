## ADDED Requirements

### Requirement: Per-token rewards and revenue
For each losing vault the system SHALL collect the battle-snapshotted configurable total fee and distribute the remainder proportionally to final-winner participants. Default total fee is 0.1%, split equally between creator and protocol. A protocol-created battle SHALL allocate the entire fee to protocol. Numerical scenarios below use the default policy unless stated otherwise.

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
The system SHALL collect `fee = floor(loser_vault * total_fee_bps / 10000)` and assign `loser_vault - fee` to the winner pool. For user-created battles it SHALL allocate `floor(fee * creator_share_bps / 10000)` to the creator and the remaining fee to protocol. Protocol-created battles SHALL allocate all fee to protocol. Both parameters SHALL come from the immutable creation-time snapshot. Largest remainder SHALL apply only within the winner pool with stable beneficiary ordering.

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

### Requirement: Protocol-configurable revenue policy
Only the protocol authority SHALL change `total_fee_bps` and `creator_share_bps`. Defaults SHALL be 10 and 5000 respectively. Each parameter SHALL accept integers from 0 through 10000 inclusive, with no additional business cap. Values above 10000 SHALL be rejected because a fee cannot exceed the vault or a creator share exceed the collected fee. Updates SHALL increment the policy version and emit old/new values and the actor. Policy changes SHALL affect only battles created afterwards.

#### Scenario: Custom revenue
- **WHEN** a new user-created battle snapshots total fee 200 bps and creator share 2500 bps and a losing vault has 100000 units
- **THEN** winners receive 98000, creator 500 and protocol 1500

#### Scenario: Existing battle and overtime
- **WHEN** authority changes the global revenue policy after a battle is created, including during gathering or overtime
- **THEN** that battle retains its original fee, ratio, version and beneficiaries through settlement

#### Scenario: Full protocol fee
- **WHEN** a protocol-created battle settles under a custom policy
- **THEN** protocol receives the entire collected fee irrespective of creator share

#### Scenario: Boundary policies
- **WHEN** total fee is 0 or 10000 bps, or creator share is 0 or 10000 bps
- **THEN** integer distributions conserve the vault, including zero rewards or zero fee where applicable

#### Scenario: Unauthorized or invalid update
- **WHEN** a non-authority updates policy or either value is fractional, negative or greater than 10000
- **THEN** the update is rejected and policy/version remain unchanged
