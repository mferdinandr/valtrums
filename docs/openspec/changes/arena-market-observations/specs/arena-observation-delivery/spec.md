## ADDED Requirements

Observation capture/query/display is owned by this change. Provider qualification,
oracle scheduling and live network acceptance remain in `arena-testnet-integrations`;
this service consumes their evidence and cannot enable an unqualified mode.

### Requirement: Contract-bound market identity
Every market observation SHALL bind deployment/protocol, battle, round, community, actual source asset, optional mainnet reference mapping, source/pool/quote and frozen observation policy. The collector SHALL use explicitly configured chain/aliases and MUST NOT infer token identity from ticker or reuse the default NEAR reader as verified Robinhood coverage.

#### Scenario: Testnet token uses a mainnet reference
- **WHEN** a registered chain-46630 token is scored using its committed chain-4663 reference
- **THEN** both identities and mapping version are retained and disclosed
- **AND** the chart does not present the reference market as the testnet token's own trades

### Requirement: Durable immutable observation capture
Accepted observations SHALL be durably stored before publication or scoring submission, with stable identities, scaled integer inputs, source evidence hash, provider observation time when available and separate acquisition time. Restarts SHALL preserve ordering/deduplication; corruption, capacity exhaustion or conflicts SHALL degrade service rather than silently erase or fabricate history.

#### Scenario: Collector restarts during a round
- **WHEN** the collector restarts after persisting samples but before submitting close evidence
- **THEN** the same round identity and samples are recovered and reconciled with contract state
- **AND** repeated source records do not add duplicate volume or create a new baseline

#### Scenario: Provider supplies no observation timestamp
- **WHEN** only an API acquisition time is known
- **THEN** provider observed time remains unknown and any boundary/coverage claim follows an explicitly approved policy
- **AND** acquisition time is not relabeled as source-chain observation time

### Requirement: Frozen boundaries and fresh overtime
Lifecycle samples and submissions SHALL follow the recorded interval, candidate set and mode-specific frozen policy. Retry time MUST NOT shift start/end. Overtime SHALL use fresh baselines/counters/peaks for tied leaders only, retaining all originally locked vaults independently of chart visibility.

#### Scenario: Oracle submits late
- **WHEN** a scheduler resumes after the recorded round end
- **THEN** it uses evidence for that recorded interval or holds resolution pending
- **AND** it does not substitute a new current price or reopen deposits

### Requirement: Mode-specific coverage gates
The observation service SHALL expose a mode as live-capable only when its required provider inputs, definitions, cadence, coverage and boundary checks are verified. Price gain needs valid point prices; market-cap growth also needs circulating supply; volume ratio needs deduplicated exact-interval quote volume and initial cap; drawdown needs ordered prices with approved maximum gaps. Missing data MUST NOT be zero.

#### Scenario: Only rolling volume and FDV are available
- **WHEN** a provider returns 24-hour rolling volume and fully diluted valuation without the required interval trades/circulating supply
- **THEN** volume-ratio and market-cap-growth capabilities remain unavailable
- **AND** the service does not approximate them as verified scores

#### Scenario: Drawdown samples have a coverage gap
- **WHEN** ordered prices omit required samples or a boundary
- **THEN** coverage is incomplete and no zero-drawdown score or final winner is fabricated

### Requirement: Bounded server-side observation reads
Chart reads SHALL query persisted evidence by full namespace, round, community and bounded time/cursor parameters. Responses SHALL include watermarks, provenance, coverage, gaps and revisions. Unknown endpoints and missing samples SHALL remain explicit; the FE MUST NOT fetch all history to select its own round or silently connect across evidence gaps.

#### Scenario: Missing close sample
- **WHEN** earlier valid samples exist but the required closing observation is absent
- **THEN** the response identifies the incomplete close and the chart leaves a gap/pending endpoint
- **AND** no synthetic end point or interpolated close is used for resolution

### Requirement: Display scores do not resolve battles
Backend chart scores SHALL preserve exact signed numerator/positive-denominator representations and declare their provisional/evidence status. Floating-point FE coordinates, animation intensity and provisional leaders SHALL have no financial authority. Recorded outcome/receipt references SHALL be separate from provisional chart estimates.

#### Scenario: Rounded chart labels appear tied
- **WHEN** two display labels round to the same percentage but exact rational values differ
- **THEN** the FE does not create an overtime or final result from those labels
- **AND** recorded contract resolution remains authoritative

#### Scenario: Provisional leader changes
- **WHEN** available samples change the provisional chart leader
- **THEN** only visual leader indicators change; deposits, candidates, rewards and held principal do not change without recorded transitions

### Requirement: Preserve legacy baseline semantics
Legacy initial/final contract prices and optional spot observations SHALL retain their own provenance and baseline semantics. A chart comparing spot to a recorded TWAP baseline MUST be labeled accordingly and MUST NOT be represented as a target point-observation round. Initial/final snapshots alone MUST NOT become an invented continuous history.

#### Scenario: Only legacy start and final prices exist
- **WHEN** no intermediate observation archive is available
- **THEN** the chart displays those available snapshots without fabricated intermediate prices

### Requirement: Synchronized and reversible evidence delivery
Frontend delta polling SHALL use backend cursors, reject stale/foreign-namespace responses, respect source freshness and handle canonical retractions explicitly. Display polling cadence MUST NOT be advertised as provider observation cadence. Pausing visuals or hiding the tab MUST NOT pause backend collection, scheduling or authoritative state.

#### Scenario: Source reorganization invalidates provisional samples
- **WHEN** a previously served provisional block/evidence reference is retracted
- **THEN** the server issues a revision/snapshot change and the client reloads affected projections with reconciliation status
- **AND** in-flight action IDs and finalized financial obligations are not reset or forgotten

### Requirement: Isolated fixture provenance
Synthetic sample series SHALL remain separately labeled fixture data and SHALL NOT satisfy live provider, scoring, custody or payout acceptance. Missing live data MUST NOT select a visually plausible fixture series as a fallback.

#### Scenario: Live sample service is unavailable
- **WHEN** the live observation endpoint fails while the application has demo generators available
- **THEN** the chart shows unavailable/stale evidence with explicit provenance
- **AND** no demo-generated points are presented as observations of the live battle
