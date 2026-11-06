## ADDED Requirements

### Requirement: Critical risk rejection and unknown-data hold
The system SHALL reject critical GoPlus risks and hold approval Pending for missing mandatory data, stale evidence, unsupported coverage or unresolved required policy.

#### Scenario: Critical finding
- **WHEN** GoPlus reports a mapped critical risk for one community
- **THEN** the proposal is rejected

#### Scenario: Incomplete response
- **WHEN** a mandatory GoPlus field is absent or chain coverage is unsupported
- **THEN** approval remains Pending rather than passing

#### Scenario: Open tax or admin policy
- **WHEN** tax thresholds or privileged-admin policy needed for approval are unresolved
- **THEN** the system does not invent a threshold or silently approve

### Requirement: Independent strict liquidity gate
Every community SHALL pass a separate evidence-backed LP check strictly greater than USD 10000.

#### Scenario: Threshold equality
- **WHEN** LP value is exactly USD 10000
- **THEN** approval is withheld

#### Scenario: Independent evidence
- **WHEN** GoPlus passes but independent LP evidence is absent
- **THEN** approval remains Pending
