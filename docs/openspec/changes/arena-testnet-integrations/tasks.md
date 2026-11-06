# Tasks

Check tasks only after implementation and verification. Research can proceed independently; live acceptance requires the dependent changes and real testnet evidence.

## Network and provider evidence

- [ ] Verify NEAR testnet and Robinhood testnet chain ID `46630`, configured RPC identity and testnet account mappings.
- [ ] Verify signer account, custody path, derived address, gas funding and deployed code hashes for the isolated testnet setup.
- [ ] Refuse signing and source receipt acceptance when RPC chain identity differs from configuration.
- [ ] Record actual source receipt, attribution, finality and reorg-verification evidence.
- [ ] Verify GoPlus testnet and independent liquidity coverage for selected assets; explicitly record unsupported or missing fields.
- [ ] Verify price, circulating supply, eligible volume, drawdown sampling and finality sources against the frozen 30-second policy.
- [ ] Label fixtures and distinguish adapter demonstrations from verified public-service integrations.

## Intents and Bitte

- [ ] Verify Intents testnet asset discovery, quote, route and funding/refund status for the selected assets.
- [ ] Verify Bitte orchestration of a canonical arena preview and user-authorized action.
- [ ] Bind the user action, preview, authorization, Intents route status and final custody receipt in recorded evidence.
- [ ] Record unsupported routes as integration gaps; direct deposit alone does not complete Intents or Bitte acceptance.

## Observability and recovery

- [ ] Persist finalized indexer cursors, block hashes and deduplication keys and reconcile chain state after restart.
- [ ] Detect reorgs, retract provisional projections and suspend affected confirmations until finality is restored.
- [ ] Display entitlement, transfer and DAO principal states separately, with source and freshness.
- [ ] Add recovery alerts for missing audit/market data, deficits, unresolved payouts and indexer reconciliation.
- [ ] Test replay and restart without duplicate allocation or payment.

## End-to-end acceptance

- [ ] Demonstrate two- and three-community battles, user and protocol creators, and real creator participation.
- [ ] Demonstrate all four modes, repeated ties, zero observations and incomplete audit or market data.
- [ ] Demonstrate per-token conservation, rounding, independent rewards and payout retry without duplicate spend.
- [ ] Demonstrate at least two independently user-funded player agents using MCP under separate grants.
- [ ] Map evidence to Memecoins With Mechanics, Games With Real Economies, Social Money and AI Swarms while identifying open DAO rules.
- [ ] Run end-to-end failure and recovery tests and obtain independent review of the implemented target.
