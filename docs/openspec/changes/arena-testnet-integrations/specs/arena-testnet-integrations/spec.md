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

### Requirement: Persistent arena event indexing foundation
A read-only indexer SHALL parse Valtrum NEP-297 logs with receipt provenance, persist a replayable journal and cursors, resume after restart, replay deterministically, and roll back provisional forks. It SHALL keep provisional and finalized status distinct, treat a source label as a declared assertion rather than verified finality, and hold no write authority: it never submits, signs, allocates, confirms foreign payments or releases custody, and a retraction is a read-model operation only.

#### Scenario: Deterministic replay and restart
- **WHEN** the committed journal is replayed, or ingest is restarted from the persisted cursor
- **THEN** the normalized projection and its digest are identical, with no duplicate activity and no write side effect

#### Scenario: Provisional fork replacement
- **WHEN** a provisional block above the finalized boundary is replaced by a different canonical block
- **THEN** the orphaned effects are retracted and the replacement branch is replayed exactly once

#### Scenario: Finality conflict is not rewritten
- **WHEN** the source contradicts or regresses a finalized block, or evidence is corrupt
- **THEN** the indexer reports a pending/degraded/reconciliation-required status, preserves committed state and evidence, and never rewrites finalized state or resets to an empty cursor

#### Scenario: Honest provenance and identity
- **WHEN** a log is from a non-allowlisted emitter or failed outcome, carries an unsafe numeric value, or reuses an event identity with a different payload
- **THEN** it is quarantined with bounded provenance rather than applied, and recorded coverage is labeled a declared source assertion, not verified finality

### Requirement: Four-track demonstration mapping
The documentation and acceptance evidence SHALL identify Memecoins With Mechanics, Games With Real Economies, Social Money and AI Swarms as the selected hackathon tracks without claiming completed integrations or award eligibility.

#### Scenario: AI Swarms evidence
- **WHEN** demonstrating the AI Swarms track
- **THEN** at least two independently user-funded player agents interact with the shared arena through MCP within their own grants; a lone prompt parser or infrastructure workers alone do not satisfy the demonstration

#### Scenario: Social Money evidence
- **WHEN** describing community entitlements and principal escrow
- **THEN** the demonstration distinguishes these from the still OPEN DAO voting rules

### Requirement: Planned Intents and Bitte integration
The target SHALL include NEAR Intents funding/routing and Bitte agent orchestration, with roles distinct from Chain Signatures authorization and source receipt verification. Unverified testnet support SHALL remain an explicit integration gap rather than silently making these dependencies optional.

#### Scenario: Direct deposit only
- **WHEN** a direct Robinhood testnet deposit and payout succeed without Intents or Bitte
- **THEN** the custody subsystem can be evidenced but the planned Intents and Bitte acceptance remains incomplete

#### Scenario: Intended service flow
- **WHEN** a supported funding action is orchestrated through Bitte and routed through Intents
- **THEN** evidence binds the preview, authorization, route status and final custody receipt to the same user action; fixture evidence remains labeled

### Requirement: Application worker and projection handoffs
Integration SHALL verify a restart-safe scheduler consuming persisted frozen-round evidence, compatible live event projections and separately authorized custody verification transport. Unsupported providers, unknown relevant events and absent runtime capabilities SHALL remain explicit release gates.

#### Scenario: New round events are unsupported by the indexer
- **WHEN** an allowlisted emitter produces an unmodelled relevant event
- **THEN** the projection remains degraded until a reviewed reducer/version handoff is verified rather than claiming complete application history

### Requirement: Spendable custody release gate
Source deposits SHALL remain disabled until evidence proves the deployed custody path permits the reservation-bound payout sender to spend the actual received assets. Deposit-only test custody SHALL NOT satisfy this gate. Custody redesign SHALL receive financial/security review before deployment or funding.

#### Scenario: Signer cannot spend held tokens
- **WHEN** a signer EOA exists but deposited tokens are held in a contract with no authorized withdrawal path
- **THEN** deposit/payout readiness remains false and integration does not request additional deposits into that path
