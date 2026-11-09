# Tasks

Check tasks only after implementation and verification. Research can proceed independently; live acceptance requires the dependent changes and real testnet evidence.

## Network and provider evidence

- [ ] Verify NEAR testnet and Robinhood testnet chain ID `46630`, configured RPC identity and testnet account mappings.
  - [x] Recorded 2026-11-08 (`docs/testnet-evidence.md`): NEAR testnet `chain_id`/genesis hash and Robinhood testnet chain id 46630 agree across two providers each; Robinhood's own testnet RPC fails TLS. The only deployment (`8875bb`) is the legacy arena (no lifecycle API), so target account mappings cannot be verified until the target is deployed.
- [ ] Verify signer account, custody path, derived address, gas funding and deployed code hashes for the isolated testnet setup.
  - Not verified: no target deployment, MPC signer configuration, derived address or funded gas exists yet (`docs/testnet-evidence.md`, section 2).
- [x] Refuse signing and source receipt acceptance when RPC chain identity differs from configuration. Verified by fake-RPC tests (`agent/test/chain-guard.test.ts`, `foreign-executor.test.ts`, `custody-verifier.test.ts`); no live network claim.
- [ ] Record actual source receipt, attribution, finality and reorg-verification evidence.
  - Not verified: needs funded deposits and payouts on the target deployment; only the presence of a `finalized` head on Robinhood testnet is recorded.
- [x] Verify GoPlus (chain `4663`) and independent liquidity coverage for the mainnet reference token of each testnet mock; explicitly record unsupported or missing fields.
  - Recorded 2026-11-08 for the 13 candidate reference tokens (no mock is registered yet), with each missing GoPlus field and each unsupported pool (Uniswap v4 and other DEX types) listed in `docs/evidence/2026-11-08-arena-audit-verification.json`. Repeat for each mock once the registry has entries.
- [x] Maintain a protocol-controlled registry mapping each testnet mock token to its Robinhood mainnet reference token, shared by audit and scoring; reject unregistered mappings.
  - Mechanism only: protocol-account-controlled entries (D33) in the arena contract, enforced at battle creation and read by audit and scoring through `agent/src/reference-registry.ts`. No entries are registered; the candidate mainnet tokens still need owner verification (see the GoPlus coverage task).
- [ ] Verify price, circulating supply, eligible volume, drawdown sampling and finality sources for the mainnet reference tokens against the frozen 30-second policy.
  - [x] Research recorded 2026-11-08 in `docs/scoring-market-data.md` (aggregator responses only; no compliant supply source, no observable finality, Robinhood RPC unreachable over valid TLS). On-chain verification and the owner's provider/cadence/tolerance decision remain open.
- [x] Label fixtures and distinguish adapter demonstrations from verified public-service integrations. (Runtime mock adapters carry `FIXTURE` labels in code, the web navbar shows "demo data" in mock mode, tests are fixtures by convention, and only `docs/evidence/` and dated findings are live observations; see `docs/testnet-evidence.md`, section 4.)

## Intents and Bitte

- [ ] Verify Intents testnet asset discovery, quote, route and funding/refund status for the selected assets.
  - [x] Recorded 2026-11-08 (`docs/intents-evidence.md`): 1Click lists Robinhood mainnet (`hood`: USDG, WETH, ETH, CASHCAT, USDe, PONS) and dry-quotes NEAR USDC to CASHCAT, USDG and ETH; it lists no testnet asset, so no testnet route, funding or refund status can be verified.
- [ ] Verify Bitte orchestration of a canonical arena preview and user-authorized action.
  - Not verified: no Bitte account or agent exists; the #76 action boundary and #77 proposals are the integration points.
- [ ] Bind the user action, preview, authorization, Intents route status and final custody receipt in recorded evidence.
  - Not verified: needs the target testnet deployment, a supported route and a funded action.
- [x] Record unsupported routes as integration gaps; direct deposit alone does not complete Intents or Bitte acceptance. (`docs/intents-evidence.md` section 4: Intents on testnet and Bitte are gaps; the arena boundary refuses non-direct routes with `unsupported_route`.)

## Observability and recovery

- [ ] Persist finalized indexer cursors, block hashes and deduplication keys and reconcile chain state after restart.
  - [x] Read-only indexing foundation (`agent/src/indexer/`): injectable `BlockSource`, validated NEP-297 parser that authenticates the receipt executor before parsing (foreign-emitter logs are dropped without storing their raw body) and handles u64 losslessly, pure deterministic projection, atomic single-snapshot store with single-writer lock, dedup keyed by network|contract|receipt|logIndex|itemIndex, restart recovery that verifies source identity/hash/ancestry and restores the last persisted health before advancing, and a runnable recorded-import/status/replay CLI whose import/status/replay exit non-zero when the indexer is degraded or needs reconciliation. Fail closed on corrupt state; never silently reset.
  - [ ] Verify against a live NEAR archival/indexing provider and record source identity, finality and reorg evidence (live-adapter integration remains open).
- [ ] Detect reorgs, retract provisional projections and suspend affected confirmations until finality is restored.
  - [x] Read-model reorg handling in the engine: parent/hash continuity, common-ancestor rollback of provisional effects, canonical replay, finality promoted only along the source-declared finalized ancestor chain, and a visible healthy/pending/degraded/reconciliation-required status that is persisted (a restart never silently reports healthy), degrades on coverage/integrity gaps from an allowlisted emitter (unmodelled or unsupported events, with bounded quarantine), and never advances over a block the source marks incomplete. Retraction is read-only and never touches custody/payouts; a conflict at or below the finalized boundary stops and requires reconciliation instead of rewriting finalized state.
  - [ ] Suspend real custody/payout confirmations on reorg (belongs to backing/payout services, not the indexer; remains open).
- [x] Display entitlement, transfer and DAO principal states separately, with source and freshness. (`inspect_account_state` in `agent/src/mcp/account-state.ts`; portfolio `AccountStatePanel`; fixture-tested per state.)
- [x] Add recovery alerts for missing audit/market data, deficits, unresolved payouts and indexer reconciliation. (`list_recovery_alerts` in `agent/src/mcp/alerts.ts`, recomputed per read so each alert clears when resolved; portfolio `RecoveryAlerts`; fire-and-clear tests per condition.)
- [ ] Test replay and restart without duplicate allocation or payment.
  - [x] Deterministic replay/restart of the read model proven on disk: identical projection/digest for full replay vs incremental ingest, idempotent re-sync, the last health status restored on restart, and no write side effects (read-only dependencies). Actual contract allocation/payment end-to-end remains open.

## End-to-end acceptance

- [ ] Demonstrate two- and three-community battles, user and protocol creators, and real creator participation.
- [ ] Demonstrate all four modes, repeated ties, zero observations and incomplete audit or market data.
- [ ] Demonstrate per-token conservation, rounding, independent rewards and payout retry without duplicate spend.
- [ ] Demonstrate at least two independently user-funded player agents using MCP under separate grants.
- [ ] Map evidence to Memecoins With Mechanics, Games With Real Economies, Social Money and AI Swarms while identifying open DAO rules.
- [ ] Run end-to-end failure and recovery tests and obtain independent review of the implemented target.
