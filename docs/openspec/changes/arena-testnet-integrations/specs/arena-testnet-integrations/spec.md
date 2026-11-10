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
The arena SHALL keep one protocol-controlled registry (changed only by the protocol account with one yocto, not the arena owner) mapping each testnet mock token to one Robinhood mainnet (4663) reference token, with an entry hash per entry and a version bumped on every change. Audit and scoring SHALL read this registry only. Battle creation SHALL refuse a reference pair that is unregistered or differs from the entry. An entry attests nothing about the mock contract.

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

### Requirement: Separately qualified finalized live source
Live indexing SHALL be separately configured from recorded replay, pin network/genesis/source identity, validate canonical headers and shard/receipt identity, bound retries and response size, and preserve finalized state on failure/regression. Missing source documents SHALL remain incomplete unless a canonical successor proves a skipped height. Provider-declared completeness SHALL NOT be described as cryptographic outcome verification or complete deployment coverage.

#### Scenario: Source mode changes after restart
- **WHEN** a live provider configuration tries to reuse a store created under recorded or conflicting source identity
- **THEN** opening fails rather than relabelling persisted fixture data as live evidence

#### Scenario: Hydrated block omits a shard
- **WHEN** a live document lacks a canonical shard or has a mismatched header/receipt
- **THEN** the source fails closed and the indexer cannot report current healthy canonical coverage from it

### Requirement: Labelled testnet Intents fixture
A local fixture of the 1Click API with a fake solver SHALL provide the testnet funding path through the route `intents-fixture`. It SHALL be accepted only in a testnet configuration, labelled in logs, responses, previews, statuses and UI, and pinned to the recorded mainnet responses. It SHALL NOT count as Intents verification; the real route stays a gap and other routes stay refused.

#### Scenario: Fixture matches the recording
- **WHEN** the fixture's discovery and dry quotes are compared with the recorded mainnet responses
- **THEN** field names, types, formats, decimals and quoted amounts match, and any drift fails a test

#### Scenario: Route acceptance
- **WHEN** a deposit names `intents-fixture` outside a testnet configuration, or any route other than `direct` and the enabled fixture route
- **THEN** the action boundary refuses it as `unsupported_route` before anything is stored

#### Scenario: Solver failure and refund
- **WHEN** the fake solver fails or refunds a funded quote
- **THEN** nothing is credited, and a replayed delivery receipt credits at most once

#### Scenario: Fixture labelling
- **WHEN** a quote, status, preview, action status or terminal result concerns the fixture
- **THEN** it carries the fixture label and is never presented as a verified Intents integration

### Requirement: Testnet token faucet
A testnet faucet SHALL give a verified account small amounts of already backed NEP-141 representation tokens from a dedicated faucet account, and SHALL NOT mint any representation. It SHALL authenticate the requesting account with a read session, limit each account and token to one claim per cooldown and bound the total sent per hour, and SHALL send nothing unless it was started live. Its key SHALL control only the faucet's own balance and never a player's funds.

#### Scenario: First claim
- **WHEN** an authenticated account without storage on a representation token claims it
- **THEN** the faucet pays that account's minimum storage registration and transfers the configured amount, and records the claim

#### Scenario: Claim again too soon
- **WHEN** the same account claims the same token inside the cooldown
- **THEN** the faucet sends nothing and reports how long remains

#### Scenario: Empty faucet
- **WHEN** the faucet account holds less than the configured amount
- **THEN** the faucet sends nothing and reports that the token is unavailable, never a partial amount

#### Scenario: Dry run
- **WHEN** the faucet is not live
- **THEN** it reports what it would send, records nothing and sends nothing

#### Scenario: Unauthenticated or forged request
- **WHEN** a request has no valid read session for the account
- **THEN** it is rejected and the claim account is never taken from the request body

