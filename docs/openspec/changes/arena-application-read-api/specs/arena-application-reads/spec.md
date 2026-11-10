## ADDED Requirements

### Requirement: Explicit deployment and protocol identity
The application SHALL namespace reads by network, arena contract, protocol and exact decimal-string battle ID. It SHALL select adapters through a validated manifest with independently evidenced capabilities and SHALL NOT silently substitute fixtures or legacy state.

#### Scenario: Lifecycle dependency fails
- **WHEN** a configured lifecycle deployment returns an RPC or service error
- **THEN** the client displays unavailable/degraded lifecycle data and does not switch to mock or legacy economics

### Requirement: Lossless boundary values
The service SHALL preserve integer amounts, timestamps and identifiers without JavaScript precision loss. Unsafe bare JSON numbers SHALL be rejected until a reviewed lossless decoder or safe ABI view exists.

#### Scenario: Contract returns an unsafe identifier
- **WHEN** a bare numeric ID exceeds the safe integer range
- **THEN** the adapter reports an unsupported boundary and does not stringify the rounded value as a valid ID

### Requirement: Bounded backend search and discovery
Battle lists and asset selectors SHALL send filters/search to the backend and render bounded cursor results, with default page size 20 and maximum 50, preserving the existing search contract within the reference ceiling of 100. Text clients SHALL debounce normally 300 ms, immediately invalidate and cancel superseded requests and prevent stale responses replacing newer results, including during debounce.

#### Scenario: Search responses arrive out of order
- **WHEN** a response for an older asset query arrives after the current query
- **THEN** it is discarded and only the current backend result is rendered

### Requirement: Read-only validated gateway
The application gateway SHALL validate supported read paths/parameters and forward only to configured allowlisted services. Neither gateway nor read service SHALL possess financial signing keys or expose arbitrary upstream proxying or mutation endpoints.

#### Scenario: Request attempts arbitrary forwarding
- **WHEN** a caller supplies an unsupported route or upstream URL
- **THEN** validation rejects it without fetching the supplied destination

### Requirement: Provenance and incomplete-state delivery
Read responses SHALL expose origin, namespace, freshness, nullable source observation time, acquisition time, canonical watermark and available source references. Missing audit reports, expired evidence, incomplete history and unsupported views SHALL remain distinct from confirmed zero/empty state. Cached evidence SHALL NOT authorize admission or financial transitions.

#### Scenario: Audit archive is unavailable
- **WHEN** a battle read succeeds but its audit evidence cannot be loaded
- **THEN** the response identifies missing evidence and does not report audit approval from an empty report

### Requirement: Capability-specific health
The service SHALL expose capability-specific dependency health and disable unsupported lifecycle projections without claiming complete live integration. A recorded read-model fixture SHALL NOT satisfy live-indexer acceptance.

#### Scenario: Only recorded indexer data is available
- **WHEN** the server reads a recorded fixture without a verified live source
- **THEN** it labels recorded provenance and does not advertise live discovery readiness

### Requirement: Namespace-bound snapshot pagination
The versioned facade SHALL bind cursors to the full deployment namespace, resource, normalized filters, ABI evidence and bounded projection snapshot. It SHALL reject foreign cursors and return snapshot_changed when that projection changes. RPC scans SHALL NOT claim atomic canonical coverage, finality or source observation timestamps. Search truncation at 200 recent IDs SHALL be explicit.

#### Scenario: A projection changes between pages
- **WHEN** a client presents a cursor for an older bounded projection
- **THEN** the service returns snapshot_changed and instructs the client to restart without that cursor

### Requirement: Explicit audit archive handoff
The application archive adapter SHALL require an explicit deployment namespace binding for archive v1, filter observations by arena and exact safe battle identity, retain individual source labels and historical TTL semantics, and disclose that network/protocol attribution is an operator handoff. Registry membership SHALL NOT establish current asset eligibility.

#### Scenario: Archive configuration lacks namespace evidence
- **WHEN** an archive path is configured without an explicit namespace binding
- **THEN** application audit reads remain unsupported with a reason, and recorded observations cannot become live evidence

### Requirement: Server-owned signing parameters
The read service SHALL publish the NEP-413 read message and the session and action recipients through a read-only, non-secret endpoint, and the gateway SHALL forward only those known fields, so a browser signs exactly what the service expects.

#### Scenario: The upstream answers with extra or malformed fields
- **WHEN** the upstream configuration response has an unknown field or a malformed value
- **THEN** the gateway drops the unknown field or answers unavailable, and never forwards the malformed value

### Requirement: Assertion-labeled process and custody health
Health components that report another process or operator-configured facts (oracle status, custody spendability) SHALL be labeled as that report, SHALL never be reported healthy, and SHALL report unavailable when their source is missing or unreadable.

#### Scenario: A deposit-only custody path is configured
- **WHEN** a configured custody path keeps tokens in a contract the payout signer does not control
- **THEN** source transfers are reported disabled with the specific reason
