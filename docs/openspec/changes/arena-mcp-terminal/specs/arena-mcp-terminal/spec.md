## ADDED Requirements

### Requirement: Read preview authorize execute boundary
MCP and terminal clients SHALL expose source/freshness-aware reads, canonical previews and revalidated authorized execution with durable action status.

#### Scenario: Preview changes
- **WHEN** the transaction differs from the authorized preview
- **THEN** execution is refused pending valid authorization

#### Scenario: Read tool
- **WHEN** a model calls inspect_battle
- **THEN** no signing or spending authority is granted

#### Scenario: Account-scoped read
- **WHEN** a read session for one account asks for another account's positions, payouts or escrow
- **THEN** the read is refused and no other account's data is returned

#### Scenario: Read envelope
- **WHEN** any read tool answers
- **THEN** the answer carries network, source kind, observation time, freshness and limitations, and fixture data is labeled as fixture

#### Scenario: Backend search
- **WHEN** the user types into a searchable list or changes a filter
- **THEN** text is debounced, filters are sent to the backend, the previous request is cancelled and a stale response is ignored

#### Scenario: Payment status
- **WHEN** only a transaction hash exists
- **THEN** the tool reports broadcast/pending rather than confirmed receipt

### Requirement: Unsupported routing transparency
The terminal SHALL explicitly reject unsupported testnet funding routes without claiming fixture output as live execution.

#### Scenario: Unverified Intents route
- **WHEN** Robinhood testnet route support cannot be established
- **THEN** the client shows unsupported and does not submit funds
