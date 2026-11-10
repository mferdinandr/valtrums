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

### Requirement: Reservation release and grant lifecycle
A user or delegate SHALL cancel an undispatched reservation, and an undispatched reservation SHALL expire after a configured lifetime. A dispatched obligation SHALL NOT be released by timeout, cancel or revocation. A delegate SHALL differ from the user and revocation SHALL be permanent per grant id.

#### Scenario: Cancel before dispatch
- **WHEN** the user or delegate cancels an undispatched reservation, even after revocation
- **THEN** its budget is restored once, a repeat is harmless and infrastructure callers are denied

#### Scenario: Expiry
- **WHEN** an undispatched reservation passes its expiry and anyone releases it
- **THEN** its budget is restored; before expiry the release fails and an expired reservation cannot be dispatched

#### Scenario: Dispatched obligation retained
- **WHEN** a dispatched obligation sees cancel, expiry or revocation
- **THEN** it stays reserved until explicit evidence reconciles it

### Requirement: Receipt-evidenced obligation reconciliation
The user or delegate SHALL dispatch a battle-bound reservation. A dispatched obligation SHALL be consumed only by an undisputed finalized registry claim binding the grant asset, user, battle and exact reserved amount; one receipt settles at most one reservation. No executor or infrastructure role SHALL confirm or release it.

#### Scenario: Matching receipt consumes once
- **WHEN** anyone submits a receipt whose active registry claim binds exactly to a dispatched obligation
- **THEN** its budget is consumed once, the receipt is marked used, and a repeat or second reservation using it changes nothing

#### Scenario: Evidence that does not bind
- **WHEN** the claim is missing, disputed, finality-incomplete or differs in asset, beneficiary, battle or amount, or the registry call fails
- **THEN** nothing is consumed or released, the obligation stays reserved and the deposit is refunded

#### Scenario: No trusted executor
- **WHEN** an auditor, scheduler, relayer, operator, verifier or the owner tries to dispatch, flag, confirm or release an obligation
- **THEN** it is denied; only the user or delegate dispatches and only registry evidence consumes

#### Scenario: Permanent revocation and delegate rule
- **WHEN** a revoked grant is replaced by a higher version, or a user names themselves delegate
- **THEN** the call is rejected; a new local grant id is required, and asset identity remains immutable

### Requirement: Player agent program
A player agent program SHALL act only through the delegate account named in an operator-supplied configuration, choose a deposit with a declared strategy, and submit it only as a proposal through the action boundary. It SHALL hold only the delegate's own key, SHALL sign nothing except the contract's `reserve`, and SHALL NOT move tokens. A strategy SHALL carry no authority: the user's grant is the only limit.

#### Scenario: Dry run by default
- **WHEN** the program runs without the live flag
- **THEN** it chooses, previews, applies the grant check and prepares the `reserve` transaction, and signs and sends nothing

#### Scenario: A hostile model answer
- **WHEN** a model answer names a recipient, another user, a second field or another action
- **THEN** the proposal is rejected by the same validator as any proposal and nothing is signed

#### Scenario: A transaction that already left
- **WHEN** reporting or confirming a sent transaction fails
- **THEN** the program records the send, reports it as unverified and does not send that community again

#### Scenario: Limits and failure
- **WHEN** a grant is missing, revoked or expired, the budget is empty, the hourly limit is reached or consecutive failures reach the configured limit
- **THEN** the program takes no action for that agent and records why

#### Scenario: Restart
- **WHEN** the program restarts or loses its own state file
- **THEN** budgets, reservations and grant state are read from the chain, and a repeated reservation of the same request is idempotent on the contract

