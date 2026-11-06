## ADDED Requirements

### Requirement: Verified testnet-only acceptance
Target live acceptance SHALL use NEAR testnet and Robinhood Chain testnet with recorded chain identity, code/account mappings, signer verification, data coverage and receipt evidence.

#### Scenario: Fixture demo
- **WHEN** market or audit data comes from fixtures
- **THEN** the demo labels it and does not claim public-service integration

#### Scenario: Network mismatch
- **WHEN** RPC chain identity differs from configured Robinhood testnet
- **THEN** the system refuses signing and source receipt acceptance

### Requirement: End-to-end evidence and observability
The demo SHALL record two/three-community flows, protocol creator, all scoring modes, repeated ties, incomplete audit, conservation and payout retry, with distinct entitlement, transfer and DAO states.

#### Scenario: Acceptance review
- **WHEN** only legacy Ref battle evidence is available
- **THEN** the target remains unverified

#### Scenario: Indexer replay
- **WHEN** events are replayed after restart
- **THEN** the same projection results without duplicate allocation or payment

### Requirement: Four-track demonstration mapping
The documentation and acceptance evidence SHALL identify Memecoins With Mechanics, Games With Real Economies, Social Money and AI Swarms as the selected hackathon tracks without claiming completed integrations or award eligibility.

#### Scenario: AI Swarms evidence
- **WHEN** demonstrating the AI Swarms track
- **THEN** at least two independently user-funded player agents interact with the shared arena through MCP within their own grants; a lone prompt parser or infrastructure workers alone do not satisfy the demonstration

#### Scenario: Social Money evidence
- **WHEN** describing community entitlements and principal escrow
- **THEN** the demonstration distinguishes these from the still OPEN DAO voting rules
