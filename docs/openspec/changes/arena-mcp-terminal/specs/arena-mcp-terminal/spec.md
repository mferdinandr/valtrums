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

### Requirement: Lifecycle intent terminal
The web terminal SHALL turn a plain-language prompt (English or Bahasa Indonesia) into exactly one lifecycle intent (`create_battle`, `register_position`, `deposit` or `payout`) and show a reviewed canonical preview before any wallet interaction. The terminal SHALL NOT offer a legacy USDC, side A/B or funding-source flow. Model output SHALL only propose an intent; it SHALL NOT authorize, sign, select a receiver or supply an address, and every intent SHALL pass strict validation that reuses the action boundary's field rules.

#### Scenario: Register position
- **WHEN** the user types "daftar di battle 7 komunitas 2"
- **THEN** the terminal shows a register-position intent for battle 7 and community index 1 (communities are numbered from 1 for users), the reviewed `register_lifecycle_position` call and no network request to the action service

#### Scenario: Deposit with an exact amount
- **WHEN** the user types "deposit 250 ke battle 7 komunitas 2"
- **THEN** the terminal shows a deposit of exactly 250 base units, builds the reviewed `ft_transfer_call` from the battle's recorded community representation and refuses amounts that are not positive integers of at most 39 digits (decimals, signs, exponents, zero)

#### Scenario: Create battle
- **WHEN** the user asks for a battle with a scoring mode and 2 to 16 community tokens
- **THEN** each token reference is resolved through the backend asset search; the intent is refused for fewer than 2 or more than 16 communities, for an unknown mode and for duplicate assets

#### Scenario: Unresolved asset
- **WHEN** a token reference matches no registry asset or more than one
- **THEN** the terminal asks a clarifying question, never invents an address and builds no review

#### Scenario: Payout request
- **WHEN** the user asks for a payout
- **THEN** the terminal shows the reviewed request, and submitting is disabled with the specific reason (spendable custody #148 is not proven and the contract exposes no entitlement) while those conditions hold

#### Scenario: Hostile model output
- **WHEN** the optional language model returns text that is not JSON, has unknown fields, an unknown kind, a malformed address, a non-integer amount or an out-of-range battle or community
- **THEN** the reply is rejected, the deterministic parser answers instead, and nothing reaches the review or the wallet

#### Scenario: No action request before the user asks
- **WHEN** a prompt has been parsed and reviewed
- **THEN** no request to the action service or session endpoint is made until the user chooses to check the transaction preview

#### Scenario: Preview comparison and signing
- **WHEN** the user checks the preview
- **THEN** the service's canonical preview must equal the reviewed call before any authorization is requested; the wallet then signs only that preview, the receipt is verified, and a deposit's position credit is read and shown separately from the receipt

#### Scenario: Session and privilege
- **WHEN** the terminal holds an action session
- **THEN** the token is kept in memory only, signing happens only in the user's wallet and no generic action proxy accepts free text or model output
