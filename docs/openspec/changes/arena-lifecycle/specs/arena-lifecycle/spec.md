## ADDED Requirements

### Requirement: Permissionless creation with real creator participation
The system SHALL require at least two funded distinct token communities and a positive actually backed creator position, including protocol creators, before starting. It SHALL NOT require a proposal bond. A battle MAY be created with zero to sixteen communities; the two-community minimum applies at lock (D34).

#### Scenario: Creator has no stake
- **WHEN** a user or protocol creator has only paid gas or promised funds
- **THEN** the battle cannot start until a real participating position is credited

#### Scenario: Three communities
- **WHEN** three approved distinct communities have positive vaults and creator participation
- **THEN** all three can be frozen in the starting snapshot

#### Scenario: Created empty
- **WHEN** a creator creates a battle with no community and a valid start time
- **THEN** creation succeeds and communities can be added only by joining before the start

### Requirement: Scheduled start time
A battle created with a start time SHALL accept it only between now plus 60 seconds and now plus 7 days. Joining, registering a position and depositing SHALL be refused from the start time on and after a cancel. The lock SHALL NOT run before the start time. A battle created without a start time SHALL keep the earlier rules and SHALL NOT be cancellable or refundable.

#### Scenario: Start time out of range
- **WHEN** the start time is under 60 seconds away or more than 7 days away
- **THEN** creation is rejected

#### Scenario: Deposit after the start
- **WHEN** a representation transfer arrives at or after the start time of an unlocked battle
- **THEN** nothing is credited and the transfer is returned

#### Scenario: Early lock
- **WHEN** the agent calls the lock before the start time
- **THEN** the lock is refused and the battle stays open

### Requirement: Join by protocol allowlist
Before the start, any account SHALL be able to add a community by naming a representation on the protocol allowlist; the community takes the allowlisted asset identity. Only the protocol account SHALL change the allowlist (one yocto, at most 64 entries). Joining a community that already exists SHALL add no community. A joined community counts as entered only once its vault is positive (D35).

#### Scenario: Token not on the allowlist
- **WHEN** a caller joins with a representation that is not allowlisted
- **THEN** the call is refused and no community is added

#### Scenario: Repeated join
- **WHEN** a second account joins with the representation of an existing community
- **THEN** the battle keeps the same community count and the caller gets a position in that community

#### Scenario: Battle full
- **WHEN** a battle already has sixteen communities
- **THEN** a join that would add a community is refused

### Requirement: Cancel and refund below two funded communities
When the start time has passed, the battle is unlocked and fewer than two communities are funded, anyone SHALL be able to cancel it. After a cancel each depositor SHALL pull a refund of their own position, and a failed refund SHALL restore that position. With two or more funded communities the battle SHALL NOT be cancellable (D36).

#### Scenario: One funded community at the start
- **WHEN** the start time passes with one funded community
- **THEN** anyone can cancel and each depositor can claim back exactly their credited units

#### Scenario: Refund transfer fails
- **WHEN** the refund transfer to the depositor fails
- **THEN** the position is restored and a refund failure event is emitted

#### Scenario: Two funded communities
- **WHEN** two communities are funded after the start time
- **THEN** cancel is refused and the battle waits for a lock

### Requirement: Authenticated audit and backing approvals
A deposit SHALL be credited only when its target community has unexpired audit and backing approvals equal to its committed asset. A battle SHALL lock only when every funded community has both, and SHALL exclude empty communities at lock (D37). Backing approvals SHALL come only from the community's owner-trusted representation contract and be withdrawn when it is mismatched, suspended, unbalanced or unavailable.

#### Scenario: Backing mismatch or suspension
- **WHEN** the representation reports another asset, a suspension, an unbalanced ledger or no answer
- **THEN** no backing approval is stored, an earlier one is withdrawn and the battle cannot lock

#### Scenario: Only backed deposits are credited
- **WHEN** a transfer comes from a token other than the community's representation, or before the target community is approved
- **THEN** nothing is credited and the transfer is returned

#### Scenario: Empty community at lock
- **WHEN** three communities exist and one has an empty vault at the lock
- **THEN** the lock needs approvals only for the two funded communities and the empty one plays no round and holds no principal

#### Scenario: Funded approval lapses
- **WHEN** a funded community's audit or backing approval expires before the lock
- **THEN** the battle cannot lock until it is refreshed

#### Scenario: Protocol-created battle
- **WHEN** the protocol is the creator but holds no credited position
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
