## ADDED Requirements

### Requirement: Durable action store
The action store SHALL persist each action record in Postgres with the same identity rules as the file store, and an update SHALL read, transform and commit one record atomically so concurrent updates cannot lose a write. The store MUST keep its documented maximum number of actions.

#### Scenario: Idempotent preview
- **WHEN** the same action identity is submitted twice
- **THEN** the second call returns the existing record and creates no duplicate

#### Scenario: Concurrent update
- **WHEN** two updates to one action run at the same time
- **THEN** both apply in some order and neither is lost

#### Scenario: Capacity reached
- **WHEN** the store holds the maximum number of actions and a new one is created
- **THEN** the creation is rejected with a visible error and nothing is deleted

### Requirement: Immutable audit report history
The audit report archive SHALL be append-only in Postgres: an observation keyed by `observationId` MUST NOT be updated or deleted, and a value that claims an existing `observationId` with different decision content SHALL be rejected. Re-evaluating the same evidence with unchanged decision content SHALL be idempotent and keep the first-written timestamps.

#### Scenario: Update is refused
- **WHEN** a statement tries to update or delete a stored observation
- **THEN** the database rejects it

#### Scenario: Conflicting content
- **WHEN** an observation arrives with an existing `observationId` and different decision content
- **THEN** it is rejected and the stored one is unchanged

#### Scenario: Query by battle
- **WHEN** a client asks for the reports of one arena, battle and community
- **THEN** the archive returns them in time order without scanning unrelated history

### Requirement: Player and baseline state
Player agent state and watchdog baselines SHALL be stored per agent and per token in Postgres with the file stores' semantics. A baseline that is missing SHALL still be derived from current liquidity as today, and the loss of this state MUST NOT cause a double spend.

#### Scenario: Played battle remembered
- **WHEN** a player agent restarts after depositing in a battle
- **THEN** it does not deposit in that battle again

#### Scenario: Baseline survives restart
- **WHEN** the watchdog restarts
- **THEN** it reads the baseline recorded at approval, not the current liquidity

### Requirement: Restricted access and fail closed
Every table SHALL have row-level security enabled with no policy for `anon` or `authenticated`, and only the owning service SHALL connect. A malformed stored record or an unreachable database MUST stop the affected component with an error and MUST NOT reset or recreate the data.

#### Scenario: Public roles denied
- **WHEN** the project's public key reads any of these tables
- **THEN** it returns no rows

#### Scenario: Malformed record
- **WHEN** a stored record fails validation on read
- **THEN** the component refuses to proceed and reports the record instead of replacing it

### Requirement: Safe migration from files
A documented import command per store SHALL load the existing files into the tables, SHALL be idempotent, and SHALL leave the files untouched.

#### Scenario: Import twice
- **WHEN** an import command runs twice on the same file
- **THEN** each record exists once and nothing changes on the second run
