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
Battle lists and asset selectors SHALL send filters/search to the backend and render bounded cursor results, with default page size 20 and maximum 100. Text clients SHALL debounce normally 300 ms, cancel superseded requests and prevent stale responses replacing newer results.

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
