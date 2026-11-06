## ADDED Requirements

### Requirement: Read preview authorize execute boundary
MCP and terminal clients SHALL expose source/freshness-aware reads, canonical previews and revalidated authorized execution with durable action status.

#### Scenario: Preview changes
- **WHEN** the transaction differs from the authorized preview
- **THEN** execution is refused pending valid authorization

#### Scenario: Read tool
- **WHEN** a model calls inspect_battle
- **THEN** no signing or spending authority is granted

#### Scenario: Payment status
- **WHEN** only a transaction hash exists
- **THEN** the tool reports broadcast/pending rather than confirmed receipt

### Requirement: Unsupported routing transparency
The terminal SHALL explicitly reject unsupported testnet funding routes without claiming fixture output as live execution.

#### Scenario: Unverified Intents route
- **WHEN** Robinhood testnet route support cannot be established
- **THEN** the client shows unsupported and does not submit funds
