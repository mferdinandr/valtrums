## MODIFIED Requirements

### Requirement: Permissionless creation with real creator participation
The system SHALL create a battle only together with a positive deposit of a representation on the protocol allowlist, sent by the creator in the same transaction that creates the battle, including protocol creators. It SHALL NOT require a proposal bond or any fee other than storage. The creator's community is the first community of the battle and the creator is registered in it. The deposit is held as a creator escrow until that community is approved (see the escrow requirement) and SHALL NOT count as a funded vault before then. A battle SHALL NOT exist without a held or credited creator deposit. At least two funded distinct communities and a credited creator position are required before the lock; the two-community minimum still applies at lock (D34).

#### Scenario: Create without a deposit
- **WHEN** a caller asks to create a battle without sending a representation token, or sends zero units
- **THEN** no battle is created and any sent token is returned

#### Scenario: Create with a token that is not allowlisted
- **WHEN** the creator sends a representation that is not on the protocol allowlist
- **THEN** no battle is created and the transfer is returned

#### Scenario: Create with a deposit
- **WHEN** the creator sends a positive amount of an allowlisted representation with a valid mode and start time
- **THEN** one battle is created with the creator's community, the creator is registered, the amount is held in escrow and the battle id is reported

#### Scenario: Three communities
- **WHEN** three approved distinct communities have positive vaults and the creator position is credited
- **THEN** all three can be frozen in the starting snapshot

## ADDED Requirements

### Requirement: Prepaid storage for creation
Creating a battle SHALL be paid from a NEAR balance the creator prepaid on the arena, because the token transfer carries no NEAR. The arena SHALL deduct the measured storage of the new battle and position from that balance. When the balance is short the creation SHALL be refused and the token transfer returned. The unused balance SHALL be withdrawable by its owner at any time. No bond and no other creation fee SHALL be charged.

#### Scenario: Balance too small
- **WHEN** the creator's prepaid balance does not cover the storage of the new battle
- **THEN** no battle is created and the token transfer is returned

#### Scenario: Withdraw unused balance
- **WHEN** the creator withdraws prepaid NEAR that no storage uses
- **THEN** exactly that amount is returned to the creator

### Requirement: Creator escrow converts when the community is approved
The creator escrow SHALL be separate from every community vault and SHALL NOT enter the snapshot, the scores or the funded-community count. When the creator's community holds both an audit approval and a backing approval, the escrow SHALL convert to the creator's credited position and vault in the same call that completes the approvals, and the creator SHALL then count as having a position. The escrow SHALL leave the arena only by that conversion or by a refund to the account that created it.

#### Scenario: Approvals arrive
- **WHEN** the second of the audit and backing approvals is recorded for the creator's community
- **THEN** the escrow becomes the creator's position and vault and a credited event is emitted

#### Scenario: Only one approval
- **WHEN** only the audit or only the backing approval exists
- **THEN** the escrow stays held, the vault stays zero and the creator position is not credited

#### Scenario: Lock before conversion
- **WHEN** the lock is called while the creator escrow has not converted
- **THEN** the lock is refused because the creator has no position

#### Scenario: Escrow is not funded
- **WHEN** a battle has a held escrow and one other funded community
- **THEN** it counts one funded community, not two

### Requirement: Cancel and refund of an uncredited creator escrow
When the start time has passed, the battle is unlocked and the creator position is not credited, anyone SHALL be able to cancel it, even when two or more communities are funded. After the cancel the creator SHALL claim the escrow back through the refund claim and every other depositor SHALL claim their own position. A failed refund SHALL restore what it tried to return.

#### Scenario: Creator community never approved
- **WHEN** the start time passes with two other funded communities and the creator escrow still held
- **THEN** anyone can cancel and every depositor, including the creator, can claim back exactly what they hold

#### Scenario: Escrow refund fails
- **WHEN** the transfer returning the escrow fails
- **THEN** the escrow is restored and a refund failure event is emitted

#### Scenario: Creator position credited
- **WHEN** the creator position is credited and two communities are funded after the start
- **THEN** cancel is refused and the battle waits for a lock

### Requirement: Escrow visible to readers
The arena SHALL expose, for every battle, the creator escrow (account, representation and amount, or none) and whether it has converted, so that clients can tell "held, waiting for approval" from "no deposit". A battle created before this change SHALL read as having no escrow and SHALL keep its earlier behavior.

#### Scenario: Waiting for approval
- **WHEN** a client reads a battle whose creator escrow is held
- **THEN** it reports the escrow amount and that it is not credited

#### Scenario: Battle created before the change
- **WHEN** a client reads a battle that was created with the earlier rules
- **THEN** it reports no escrow and the battle behaves as before
