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
