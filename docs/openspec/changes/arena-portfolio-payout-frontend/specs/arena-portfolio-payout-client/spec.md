## ADDED Requirements

### Requirement: Attributable account projections
Account reads SHALL use bounded backend queries scoped to account, deployment and original asset, with completeness and watermark metadata. The client SHALL NOT treat open payout listings as complete history or call internal Rust helpers as RPC views.

#### Scenario: Historical payout indexing is incomplete
- **WHEN** current open requests exist but past event coverage is missing
- **THEN** the portfolio displays incomplete history instead of claiming no previous payouts

### Requirement: Separate reward reservation delivery and principal
The portfolio SHALL distinguish eligible entitlement, reserved amounts, payout progress, delivered funds, late funds and held principal by original asset. DAO-held principal SHALL remain unavailable until an approved governance mechanism exists; rewards SHALL remain independent.

#### Scenario: Reward payout is broadcast
- **WHEN** a reward request has been broadcast without confirmed finality
- **THEN** it appears pending rather than delivered and does not unlock principal

### Requirement: Stable and bound wallet requests
Wallet payout requests SHALL use exact integer amounts, validated 32-byte request IDs and 20-byte destinations, bound to backing/account/asset and reviewed before signing. Retries SHALL reconcile an existing request before allocating a new identity. Late refunds SHALL use their separately bound refund path.

#### Scenario: Browser reloads after payout submission
- **WHEN** a previously submitted request is recovered after reload
- **THEN** the client queries its bound status before offering a retry and does not create a duplicate payout by default

### Requirement: Reconciliation states preserve authority
The client SHALL distinguish authorized, signing_requested, signed, broadcast, pending_finality, reverted, reconciliation_required, confirmed and restored states. It SHALL derive delivery/restoration from authoritative records and SHALL NOT hold signer or confirmation-operator authority.

#### Scenario: Confirmation times out
- **WHEN** a broadcast payout has no confirmed outcome before a client timeout
- **THEN** it remains pending/unknown with reconciliation status rather than becoming paid or automatically restored

### Requirement: Capability-gated financial actions
Lifecycle payout actions SHALL require verified contract/backing capabilities, spendable custody and signing-owner runtime evidence. Legacy claims SHALL remain separate. Wallet beneficiary fields SHALL NOT be treated as authority over another account's custody.

#### Scenario: Payout library exists without runnable signing worker
- **WHEN** contract tests pass but signing initiation has not been live-verified
- **THEN** the UI permits supported account reads but does not advertise live payout readiness
