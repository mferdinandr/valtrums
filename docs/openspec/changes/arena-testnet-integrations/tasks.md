# Tasks

Check tasks only after implementation and verification. Research can proceed independently; live acceptance requires the dependent changes and real testnet evidence.

## Network and provider evidence

- [ ] Verify NEAR testnet and Robinhood testnet chain ID `46630`, configured RPC identity and testnet account mappings.
- [ ] Verify signer account, custody path, derived address, gas funding and deployed code hashes for the isolated testnet setup.
- [ ] Refuse signing and source receipt acceptance when RPC chain identity differs from configuration.
- [ ] Record actual source receipt, attribution, finality and reorg-verification evidence.
- [ ] Verify GoPlus (chain `4663`) and independent liquidity coverage for the mainnet reference token of each testnet mock; explicitly record unsupported or missing fields.
- [ ] Maintain a protocol-controlled registry mapping each testnet mock token to its Robinhood mainnet reference token, shared by audit and scoring; reject unregistered mappings.
- [ ] Verify price, circulating supply, eligible volume, drawdown sampling and finality sources for the mainnet reference tokens against the frozen 30-second policy.
- [ ] Label fixtures and distinguish adapter demonstrations from verified public-service integrations.

## Intents and Bitte

- [ ] Verify Intents testnet asset discovery, quote, route and funding/refund status for the selected assets.
- [ ] Verify Bitte orchestration of a canonical arena preview and user-authorized action.
- [ ] Bind the user action, preview, authorization, Intents route status and final custody receipt in recorded evidence.
- [ ] Record unsupported routes as integration gaps; direct deposit alone does not complete Intents or Bitte acceptance.

## Observability and recovery

- [ ] Persist finalized indexer cursors, block hashes and deduplication keys and reconcile chain state after restart.
  - [x] Read-only indexing foundation (`agent/src/indexer/`): injectable `BlockSource`, validated NEP-297 parser with receipt-executor provenance and lossless u64 handling, pure deterministic projection, atomic single-snapshot store with single-writer lock, dedup keyed by network|contract|receipt|logIndex|itemIndex, restart recovery that verifies source identity/hash/ancestry before advancing, and a runnable recorded-import/status/replay CLI. Fail closed on corrupt state; never silently reset.
  - [ ] Verify against a live NEAR archival/indexing provider and record source identity, finality and reorg evidence (live-adapter integration remains open).
- [ ] Detect reorgs, retract provisional projections and suspend affected confirmations until finality is restored.
  - [x] Read-model reorg handling in the engine: parent/hash continuity, common-ancestor rollback of provisional effects, canonical replay, finality promoted only along the source-declared finalized ancestor chain, and a visible healthy/pending/degraded/reconciliation-required status. Retraction is read-only and never touches custody/payouts; a conflict at or below the finalized boundary stops and requires reconciliation instead of rewriting finalized state.
  - [ ] Suspend real custody/payout confirmations on reorg (belongs to backing/payout services, not the indexer; remains open).
- [ ] Display entitlement, transfer and DAO principal states separately, with source and freshness.
- [ ] Add recovery alerts for missing audit/market data, deficits, unresolved payouts and indexer reconciliation.
- [ ] Test replay and restart without duplicate allocation or payment.
  - [x] Deterministic replay/restart of the read model proven on disk: identical projection/digest for full replay vs incremental ingest, idempotent re-sync, and no write side effects (read-only dependencies). Actual contract allocation/payment end-to-end remains open.

## End-to-end acceptance

- [ ] Demonstrate two- and three-community battles, user and protocol creators, and real creator participation.
- [ ] Demonstrate all four modes, repeated ties, zero observations and incomplete audit or market data.
- [ ] Demonstrate per-token conservation, rounding, independent rewards and payout retry without duplicate spend.
- [ ] Demonstrate at least two independently user-funded player agents using MCP under separate grants.
- [ ] Map evidence to Memecoins With Mechanics, Games With Real Economies, Social Money and AI Swarms while identifying open DAO rules.
- [ ] Run end-to-end failure and recovery tests and obtain independent review of the implemented target.
