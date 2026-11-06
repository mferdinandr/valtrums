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

### Requirement: Explicit GoPlus field mapping
The auditor SHALL follow the selected field mapping in [GoPlus audit policy](../../../../../goplus-audit.md). It SHALL normalize string flags explicitly, preserve unknowns, interpret tax values as exact decimal fractions and bind evidence to the source chain/token. True `is_honeypot`, `cannot_sell_all` or `cannot_buy` SHALL reject eligibility. A tax fraction of exactly 1 SHALL reject the corresponding trading/custody path. Other tax thresholds and privilege admissibility SHALL remain OPEN until explicitly decided.

#### Scenario: Flag normalization
- **WHEN** a required flag is the string "0" or is absent
- **THEN** "0" is false and absence is Unknown/Pending, without truthiness coercion

#### Scenario: Restricted full sale
- **WHEN** `cannot_sell_all` is "1"
- **THEN** eligibility is rejected without claiming that every possible sale is blocked

#### Scenario: Critical result with incomplete fields
- **WHEN** correctly attributed evidence contains `is_honeypot` equal to "1" and another required field is absent
- **THEN** the overall result is Reject with both findings retained

#### Scenario: Tax normalization and policy gap
- **WHEN** buy tax is "0.05", sell tax is empty and admin policy is unresolved
- **THEN** buy tax is recorded as 5%, sell tax remains Unknown and the proposal stays Pending without an invented threshold

#### Scenario: Entirely taxed path
- **WHEN** any of `buy_tax`, `sell_tax` or `transfer_tax` is exactly "1"
- **THEN** eligibility is rejected for an unusable trading or custody path

#### Scenario: Privilege and coverage context
- **WHEN** a proxy or closed-source response omits required checks, or a reported privilege has unresolved admissibility
- **THEN** approval remains Pending rather than treating omission as safe or every capability as a proven attack

#### Scenario: Wrong source identity
- **WHEN** the audit result belongs to another chain or token address
- **THEN** it cannot satisfy the proposal's evidence requirements

### Requirement: Refresh validation before lock
The cron auditor SHALL refresh affected community evidence before lock under a versioned freshness policy and SHALL expose per-field reasons consistently. Cadence, evidence TTL and live-change recovery policy SHALL remain OPEN until designed.

#### Scenario: Expired or changed evidence
- **WHEN** audit evidence expires or a community/token mapping changes before lock
- **THEN** lock is refused until the affected community satisfies the refreshed audit and separate liquidity gate
