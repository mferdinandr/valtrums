## ADDED Requirements

### Requirement: Winning principal isolation
The system SHALL escrow final winning principal separately from losing-token rewards without automatic return or burn.

#### Scenario: No decision
- **WHEN** DAO governance is unresolved or no valid decision exists
- **THEN** principal remains escrowed with no invented timeout or fallback

#### Scenario: Rewards available
- **WHEN** principal is locked
- **THEN** losing-token entitlements remain independent

### Requirement: Decision-bound underlying disposition
The system SHALL execute an approved return or underlying burn/sink at most once and SHALL NOT treat representation destruction alone as proof of source-token disposal. DAO membership, weights, quorum, deadlines and fallback SHALL remain OPEN until explicitly decided.

#### Scenario: Burn versus redemption
- **WHEN** escrowed units are reserved for a valid burn disposition
- **THEN** the same backing cannot be returned or redeemed

#### Scenario: Representation-only burn
- **WHEN** NEAR units are destroyed without verified source disposal
- **THEN** the UI cannot claim Robinhood tokens were burned

#### Scenario: Split disposition
- **WHEN** a future authorized DAO decision specifies burn and return portions
- **THEN** each is independently bound to the decision and verified underlying execution; the sum cannot exceed the escrow
