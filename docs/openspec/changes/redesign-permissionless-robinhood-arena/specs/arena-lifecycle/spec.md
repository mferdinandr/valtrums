## ADDED Requirements

### Requirement: Permissionless creation with real creator participation
The system SHALL require at least two distinct token communities and a positive actually backed creator position, including protocol creators, before starting. It SHALL NOT require a proposal bond.

#### Scenario: Creator has no stake
- **WHEN** a user or protocol creator has only paid gas or promised funds
- **THEN** the battle cannot start until a real participating position is credited

#### Scenario: Three communities
- **WHEN** three approved distinct communities have positive vaults and creator participation
- **THEN** all three can be frozen in the starting snapshot

### Requirement: Immutable pre-round snapshot
The system SHALL lock communities, deposits, mode, fee identity and policies before round 1 and reject subsequent deposits through all overtime rounds.

#### Scenario: Late arrival
- **WHEN** a cross-chain deposit arrives after lock
- **THEN** it cannot change the snapshot and its attributed funds remain recoverable outside the live vault

#### Scenario: Repeated lock
- **WHEN** a scheduler repeats the same lock request
- **THEN** the original snapshot remains unchanged

### Requirement: Creation-time revenue snapshot
Every battle SHALL snapshot total fee, creator share, policy version and authenticated fee beneficiaries at creation, expose them before deposit, and retain them through lock, all rounds and settlement.

#### Scenario: Update during gathering
- **WHEN** global policy changes while an existing battle gathers deposits
- **THEN** its displayed and enforced revenue policy remains unchanged; only subsequently created battles receive the new policy
