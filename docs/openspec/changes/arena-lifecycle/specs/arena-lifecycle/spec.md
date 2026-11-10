## ADDED Requirements

### Requirement: Permissionless creation with real creator participation
The system SHALL require at least two distinct token communities and a positive actually backed creator position, including protocol creators, before starting. It SHALL NOT require a proposal bond.

#### Scenario: Creator has no stake
- **WHEN** a user or protocol creator has only paid gas or promised funds
- **THEN** the battle cannot start until a real participating position is credited

#### Scenario: Three communities
- **WHEN** three approved distinct communities have positive vaults and creator participation
- **THEN** all three can be frozen in the starting snapshot

### Requirement: Authenticated audit and backing approvals
A battle SHALL lock only when every community has an unexpired audit approval and an unexpired backing approval that both equal its committed asset. Backing approvals SHALL come only from the community's owner-trusted representation contract and be withdrawn when it is mismatched, suspended, unbalanced or unavailable.

#### Scenario: Backing mismatch or suspension
- **WHEN** the representation reports another asset, a suspension, an unbalanced ledger or no answer
- **THEN** no backing approval is stored, an earlier one is withdrawn and the battle cannot lock

#### Scenario: Only backed deposits are credited
- **WHEN** a transfer comes from a token other than the community's representation, or before every community is approved
- **THEN** nothing is credited and the transfer is returned

#### Scenario: Protocol-created battle
- **WHEN** the protocol is the creator but holds no credited position or a vault is empty
- **THEN** the battle cannot lock

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
- **THEN** it cannot change the snapshot or enter any vault
- **AND** backing reads the arena's lock state on every claim, records a locked-battle deposit as a refund-only late deposit for the beneficiary in the claim, and the payout authority can reserve its refund

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

### Requirement: Versioned application read compatibility
Reviewed application views SHALL expose lossless identifiers and activation/readiness with provenance-compatible references, reusing existing audit expiry. New historical round evidence SHALL retain actual windows, candidates, outcomes and available exact scores; records predating that storage SHALL remain explicitly incomplete.

#### Scenario: Old round lacks stored evidence
- **WHEN** a historical round predates versioned score/window storage
- **THEN** reads identify incomplete fields instead of reconstructing a fabricated exact score or window

### Requirement: Additive lossless application views
Versioned battle count, battle and position views SHALL accept/return U64 decimal strings without changing existing bare-u64 methods. Readiness SHALL expose actual activation/paused/configuration and stored backing identity/trust/expiry, without implying current custody proof or executing activation.

#### Scenario: Exact identifier exceeds JavaScript safe range
- **WHEN** a client reads a valid u64 identifier through the v1 ABI
- **THEN** the full decimal-string identifier reaches lookup without numeric rounding

### Requirement: Recorded round evidence handoff
New opened, pending and resolved v1 events SHALL bind battle/round/protocol, frozen policy, actual candidates/window and available validated exact scores/evidence hashes. Replaying an already resolved round SHALL NOT emit replacement evidence. Stored history lacking these fields SHALL remain explicitly incomplete; full evidence MAY be delivered through the durable event journal without duplicating market samples in contract state.

#### Scenario: A recorded negative winner is read
- **WHEN** a completed round's best validated score is negative
- **THEN** the event retains its exact signed numerator and positive denominator rather than rounding, clamping or reconstructing the score
