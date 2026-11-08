## ADDED Requirements

### Requirement: Bounded user delegation
A player agent SHALL use an explicit user grant enforcing token budget, methods, assets, chains, destinations, expiry and revocation outside browser-only checks. Infrastructure SHALL have no player-spending authority.

#### Scenario: Budget exceeded
- **WHEN** concurrent actions exceed the cumulative token budget
- **THEN** excess action is rejected atomically

#### Scenario: Expired or revoked grant
- **WHEN** a new action uses an expired or revoked grant
- **THEN** the authorization layer rejects it

#### Scenario: Role crossover
- **WHEN** an auditor key calls a player-spending action
- **THEN** it is denied even if the auditor is trusted for evidence

### Requirement: Untrusted strategy output
NEAR AI output SHALL be validated as a proposed bounded action and SHALL NOT widen user authorization.

#### Scenario: Metadata injection
- **WHEN** token text instructs the agent to send funds to another destination
- **THEN** the existing user policy and preview checks reject the action

### Requirement: Persistent grants and atomic budget reservations
A persistent policy contract SHALL authenticate grant creation and revocation from the NEAR caller and bind each grant to a user, delegate, immutable asset identity, bounded scope, per-action and cumulative token caps, gas bound and expiry. It SHALL reserve budget atomically against a canonical action and hold no spending authority: a reservation is an authorization and a budget hold, not a token transfer, and the normal build SHALL expose no fabricated execution-confirmation or release path.

#### Scenario: Atomic cumulative reservation
- **WHEN** two competing actions together exceed the cumulative token cap
- **THEN** at most one reserves and the invariant `consumed + reserved <= authorized_limit` holds

#### Scenario: Idempotent request and changed action
- **WHEN** the same request identity is submitted twice, or reused with a changed amount, destination, method, asset or grant version
- **THEN** the identical repeat reserves once and the changed action is rejected without altering counters

#### Scenario: Exactly-once outcome and retained ambiguity
- **WHEN** an outcome confirms execution, safely restores a never-dispatched reservation, or is ambiguous after dispatch
- **THEN** budget is consumed or released exactly once, conflicting terminal outcomes fail closed, and an ambiguous dispatched obligation is retained for reconciliation rather than released

#### Scenario: Caller authority
- **WHEN** an infrastructure role or the owner attempts to originate a reservation, or a delegate attempts to create or widen its own authority
- **THEN** it is denied; only the user creates or revokes their grant and only the delegate or user reserves within it

#### Scenario: Version change cannot evade obligations
- **WHEN** a grant is revised to a new version
- **THEN** old records and the shared budget counters are preserved, so unresolved obligations are not reset and the cumulative cap is not evaded

#### Scenario: Immutable asset and valid replacement cap
- **WHEN** a new version changes the grant's asset identity or lowers its cumulative cap below consumed plus reserved units
- **THEN** replacement is rejected without changing the existing version, history or budget; another asset requires a new grant ID

#### Scenario: Queued authorization after replacement
- **WHEN** a queued reservation's grant is replaced, including after expiry or revocation
- **THEN** the old version is denied first execution admission, while already-dispatched obligations remain attributable and reconcilable

#### Scenario: Canonical input and event envelope
- **WHEN** a grant or action contains unknown fields, including nested asset or battle fields
- **THEN** input is rejected; accepted policy changes emit versioned NEP-297 events with an array of data records
