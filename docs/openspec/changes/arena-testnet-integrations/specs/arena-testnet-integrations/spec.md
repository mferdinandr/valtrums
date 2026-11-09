## ADDED Requirements

### Requirement: Verified testnet-only acceptance
Target live acceptance SHALL use NEAR testnet and Robinhood Chain testnet with recorded chain identity, code/account mappings, signer verification, data coverage and receipt evidence.

#### Scenario: Fixture demo
- **WHEN** market or audit data comes from fixtures
- **THEN** the demo labels it and does not claim public-service integration

#### Scenario: Network mismatch
- **WHEN** RPC chain identity differs from configured Robinhood testnet
- **THEN** the system refuses signing and source receipt acceptance

#### Scenario: Missing or malformed chain identity
- **WHEN** the RPC chain id is missing, malformed or unreadable
- **THEN** the system fails closed and names the failure without exposing the RPC URL

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

#### Scenario: Every emitted event is projected or reported
- **WHEN** an allowlisted contract emits a `valtrum`, `valtrum_backing` or `valtrum_payout` event the indexer does not model
- **THEN** it is quarantined as unsupported and the status is degraded, never silently dropped; modelled events include backing approval, trust change, late deposit with refund address, suspension and payout events

#### Scenario: Replay after the same receipt is delivered again
- **WHEN** a receipt already applied, even in a pruned block, is delivered again
- **THEN** an identical payload changes nothing and a different payload requires reconciliation, never a second credit

### Requirement: Indexer reorg suspension and retention
After a reorg the indexer SHALL retract provisional projections and suspend confirmations until finality returns, and SHALL bound storage by summarizing finalized blocks older than a configurable depth into a hashed checkpoint. It SHALL never prune provisional blocks or deduplication keys.

#### Scenario: Reorg suspends confirmations
- **WHEN** provisional blocks are replaced by a fork
- **THEN** their effects are retracted, the status is not healthy and confirmations report no credits until finality reaches the highest retracted height, also after a restart

#### Scenario: Restart after pruning
- **WHEN** the indexer restarts after old finalized blocks were pruned
- **THEN** it verifies the checkpoint against the journal and the retained chain, keeps its cursors and does not double count, and a mismatch fails closed or requires reconciliation

#### Scenario: Pruning keeps what protects funds
- **WHEN** blocks are pruned
- **THEN** provisional blocks, every deduplication key and blocks holding conflict evidence remain, and the checkpoint is labelled a summary, not raw history

### Requirement: Protocol-controlled reference-token registry
The arena SHALL keep one owner-controlled registry mapping each testnet mock token to one Robinhood mainnet (4663) reference token, with an entry hash per entry and a version bumped on every change. Audit and scoring SHALL read this registry only. Battle creation SHALL refuse a reference pair that is unregistered or differs from the entry. An entry attests nothing about the mock contract.

#### Scenario: Registered mapping
- **WHEN** a community commits the reference pair registered for its token
- **THEN** creation succeeds and audit and scoring both resolve the reference token with the same entry hash

#### Scenario: Unregistered, conflicting or duplicate mapping
- **WHEN** a creator declares an unregistered or different pair, omits the pair of a registered token, or anyone but the owner adds an entry, or an entry duplicates a token or reference
- **THEN** the contract refuses it and the agent holds the community Pending

#### Scenario: Inconsistent registry read
- **WHEN** a registry read is malformed, incomplete, changes between pages or reports an entry hash that differs from its fields
- **THEN** the agent fails the pass closed and audits nothing against it

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
