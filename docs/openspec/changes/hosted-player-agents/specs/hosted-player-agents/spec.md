## ADDED Requirements

### Requirement: Testnet-only hosting
The platform SHALL host an agent key only on NEAR testnet. The hosted-agent service MUST refuse to start when the configured network is not testnet, and the UI SHALL state that the operator holds the agent key and that only valueless testnet tokens may be used.

#### Scenario: Non-testnet network
- **WHEN** the service starts with a network other than testnet
- **THEN** it refuses to start and creates no key

#### Scenario: Disclosure shown
- **WHEN** a user opens the hosted agent creation flow
- **THEN** a banner states the operator holds the key and the agent is for testnet tokens only

### Requirement: Owner authentication and isolation
Every hosted-agent action (create, start, stop, status, export) SHALL require proof that the caller controls the owner wallet account, and an owner MUST NOT read or control another owner's agent.

#### Scenario: Unauthenticated call
- **WHEN** a request carries no valid owner proof
- **THEN** the service rejects it and performs no action

#### Scenario: Cross-owner access
- **WHEN** owner A requests start, stop, status or export for an agent of owner B
- **THEN** the service rejects the request

### Requirement: Key custody
The service SHALL generate each hosted agent key on the server, store it encrypted at rest with a key-encryption key held outside the database, and MUST NOT log or return the secret key except through the explicit export action. Export SHALL require owner authentication and SHALL be recorded.

#### Scenario: Status never leaks the key
- **WHEN** an owner reads agent status
- **THEN** the response contains the agent account and balances but not the secret key

#### Scenario: Export
- **WHEN** the authenticated owner exports the key
- **THEN** the key is returned once and the export is recorded

### Requirement: Start and stop lifecycle
A hosted agent SHALL play only while started. Stop MUST take effect before the next play round, and an agent in an error or limit state SHALL stop and report the reason.

#### Scenario: Start
- **WHEN** the owner starts a funded agent
- **THEN** the runner plays under the existing autonomous-agent rules and status shows it as running

#### Scenario: Stop
- **WHEN** the owner stops a running agent
- **THEN** no new play is sent after the stop is acknowledged

#### Scenario: Unfunded start
- **WHEN** the owner starts an agent with no NEAR or no token balance
- **THEN** the service reports it is not funded and does not run model calls

### Requirement: Usage and fund caps
The service SHALL enforce a maximum number of hosted agents per owner, a per-agent cap and a global cap on model calls per hour, and a per-agent cap on funds it will play with. A global kill switch MUST stop all hosted agents and block new starts. Cap values are configured by the operator.

#### Scenario: Agent limit per owner
- **WHEN** an owner already has the maximum number of hosted agents
- **THEN** creating another is rejected

#### Scenario: Global model-call cap
- **WHEN** the global hourly model-call cap is reached
- **THEN** agents skip rounds that need a model call until the window resets

#### Scenario: Kill switch
- **WHEN** the operator turns the kill switch on
- **THEN** all hosted agents stop and starts are rejected

### Requirement: Platform-paid inference
The service SHALL call NEAR AI Cloud with a platform-held key that never reaches the browser or the owner, and SHALL record per-agent model-call counts for cost review. The agent decision rules stay as defined for the autonomous agent: the model output is untrusted, validated, and has no fallback.

#### Scenario: Key not exposed
- **WHEN** an owner uses any hosted-agent API or page
- **THEN** the NEAR AI key is not present in any response or client bundle

#### Scenario: Usage recorded
- **WHEN** an agent makes a model call
- **THEN** the per-agent counter increases and the chat id is logged with the play
