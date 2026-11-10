## ADDED Requirements

### Requirement: Winning principal isolation
The system SHALL escrow final winning principal separately from losing-token rewards without automatic return or burn.

#### Scenario: No decision
- **WHEN** DAO governance is unresolved or no valid decision exists
- **THEN** principal remains escrowed with no invented timeout or fallback

#### Scenario: Rewards available
- **WHEN** principal is locked
- **THEN** losing-token entitlements remain independent

#### Scenario: Exclusive escrow reservation
- **WHEN** the winning principal is escrowed in its backing
- **THEN** the same backing cannot be redeemed, disposed of, allocated or paid out, and only the arena can record the escrow, once per battle

#### Scenario: No disposition path
- **WHEN** the owner, a worker, the oracle or a participant tries to release or dispose of escrowed principal
- **THEN** no such method exists and the escrow is unchanged

### Requirement: Decision-bound underlying disposition
The system SHALL execute an approved return or underlying burn/sink at most once and SHALL NOT treat representation destruction alone as proof of source-token disposal. Only a decision from the contract's own vote tally SHALL be accepted.

#### Scenario: Burn versus redemption
- **WHEN** escrowed units are reserved for a valid burn disposition
- **THEN** the same backing cannot be returned or redeemed

#### Scenario: Representation-only burn
- **WHEN** NEAR units are destroyed without verified source disposal
- **THEN** the UI cannot claim Robinhood tokens were burned

#### Scenario: Split disposition
- **WHEN** a future authorized DAO decision specifies burn and return portions
- **THEN** each is independently bound to the decision and verified underlying execution; the sum cannot exceed the escrow

### Requirement: Winner-weighted disposition vote
After the final winner is recorded, the winning community's participants SHALL vote burn or return, weighted by their escrowed principal, within a window snapshotted at battle creation. No quorum or delegation. Anyone MAY finalize after the window: the burn share of votes cast applies to the whole escrow, rounded toward return. With no votes, principal SHALL stay escrowed.

#### Scenario: Split by votes cast
- **WHEN** voters with weight 60 choose burn and 20 choose return, and holders with weight 20 do not vote
- **THEN** each holder's principal is 75% burned and 25% returned, rounded per holder toward return, and burn plus return equals the escrow

#### Scenario: Nobody votes
- **WHEN** the window closes with no vote cast
- **THEN** the principal stays escrowed with no timeout, return or burn

#### Scenario: Unauthorized vote or decision
- **WHEN** a non-participant, a losing-community participant, a delegate, the owner or a worker votes, votes twice, votes after the window or submits a decision
- **THEN** it is refused and only the tally of authenticated participant votes can finalize

#### Scenario: Burn to sink
- **WHEN** the burn portion is executed
- **THEN** it is paid to the frozen sink address on Robinhood and reported as sent to sink only after a finalized receipt, never as a supply burn

### Requirement: Protocol authority under a council DAO
Protocol-level changes (the DAO vote window, the fee policy, the reference-token registry and the once-per-token burn sink) and the protocol fee recipient SHALL be controlled by a SputnikDAO council with a simple-majority policy through one-yocto function-call proposals. Automated roles (payout operator, relayer, agent, scheduler) and the deploy key SHALL NOT be held by the DAO. The DAO SHALL NOT be able to submit, change or veto a battle's disposition or move escrowed principal.

#### Scenario: Council majority changes a protocol parameter
- **WHEN** a council member proposes a one-yocto call to the arena or a backing owned by the DAO and a majority approves
- **THEN** the call executes and the parameter changes for future battles only, while an outsider, a lone council member or the deploy owner calling directly is refused

#### Scenario: DAO cannot touch votes or principal
- **WHEN** the DAO calls a vote, execute, escrow reservation or escrow release method through a passed proposal
- **THEN** the call fails and no escrow, tally or disposition changes
