## ADDED Requirements

### Requirement: Permissionless creation with real creator participation
The system SHALL require at least two distinct token communities and a positive actually backed creator position, including protocol creators, before starting. It SHALL NOT require a proposal bond.

#### Scenario: Creator has no stake
- **WHEN** a user or protocol creator has only paid gas or promised funds
- **THEN** the battle cannot start until a real participating position is credited

#### Scenario: Three communities
- **WHEN** three approved distinct communities have positive vaults and creator participation
- **THEN** all three can be frozen in the starting snapshot

### Requirement: Optional committed reference pair
A community MAY commit a mainnet reference pair with its asset identity, and the system SHALL validate it at creation.

#### Scenario: Valid or absent pair
- **WHEN** both reference fields are set to a valid chain ID and 20-byte address, or both are unset
- **THEN** creation succeeds and the address is stored lowercase

#### Scenario: Invalid or repeated pair
- **WHEN** only one field is set, the address is malformed, or two communities share a pair
- **THEN** creation is rejected

#### Scenario: Audit for another pair
- **WHEN** an approval names a different or missing pair than the committed one
- **THEN** it is refused

### Requirement: Immutable pre-round snapshot
The system SHALL lock communities, deposits, mode, fee identity and policies before round 1 and reject subsequent deposits through all overtime rounds.

#### Scenario: Late arrival
- **WHEN** a cross-chain deposit arrives after lock
- **THEN** it cannot change the snapshot and its attributed funds remain recoverable outside the live vault

#### Scenario: Repeated lock
- **WHEN** a scheduler repeats the same lock request
- **THEN** the original snapshot remains unchanged

#### Scenario: Audit refresh after lock
- **WHEN** new audit or liquidity evidence arrives after lock
- **THEN** it cannot change live status, frozen snapshot, round or result

### Requirement: Safe principal escrow before DAO design
Winning principal SHALL remain isolated until an authorized DAO mechanism is explicitly designed and implemented. Owner or worker alone SHALL NOT record a binding DAO decision, dispose principal or claim source disposal confirmed.

#### Scenario: Governance unresolved
- **WHEN** there is a unique winner but governance is unresolved
- **THEN** principal stays escrowed and losing-token rewards remain independent
