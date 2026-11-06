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
