## ADDED Requirements

### Requirement: Critical risk rejection and unknown-data hold
The system SHALL reject critical GoPlus risks and hold approval Pending for missing mandatory data, stale evidence, unsupported coverage or unresolved required policy.

#### Scenario: Critical finding
- **WHEN** GoPlus reports a mapped critical risk for one community
- **THEN** the proposal is rejected

#### Scenario: Incomplete response
- **WHEN** a mandatory GoPlus field is absent or chain coverage is unsupported
- **THEN** approval remains Pending rather than passing

#### Scenario: Unresolved policy
- **WHEN** the active policy leaves the tax threshold, privileged-admin or freshness decision unresolved
- **THEN** the system does not invent a value or silently approve and holds the token Pending

### Requirement: Versioned owner policy for tax and admin privileges
The audit SHALL apply one versioned policy object (`audit-policy-v1`) and its hash SHALL change with any resolved decision or parameter. Buy, sell and transfer tax SHALL each be admissible up to and including the exact decimal 0.05; above 0.05 SHALL reject with reason `tax_above_limit`. The capabilities `is_mintable`, `transfer_pausable`, `is_blacklisted`, `is_whitelisted`, `owner_change_balance`, `slippage_modifiable` and `personal_slippage_modifiable` SHALL be admissible only when ownership is renounced and unrecoverable (owner empty or zero address, `hidden_owner` false, `can_take_back_ownership` false); an active capability otherwise SHALL reject with reason `admin_privilege_not_renounced`. Unknown fields SHALL remain Pending.

#### Scenario: Tax at the limit
- **WHEN** buy tax is "0.05" and every other gate passes
- **THEN** the tax is admissible

#### Scenario: Tax above the limit
- **WHEN** sell tax is above 0.05 and another required field is absent
- **THEN** the result is Reject with `tax_above_limit` and the unknown finding retained

#### Scenario: Active capability without renounced ownership
- **WHEN** `is_mintable` is "1" and the owner address is non-zero
- **THEN** the result is Reject with `admin_privilege_not_renounced`

#### Scenario: Active capability with unknown ownership
- **WHEN** a capability is active and ownership status cannot be established
- **THEN** approval remains Pending

### Requirement: Reference-token audit for testnet mock tokens
GoPlus supports only chain 4663. A testnet token SHALL be audited through its mainnet reference token only when the mapping (`reference_chain_id` 4663 and `reference_address`) comes from a protocol-controlled registry in configuration. Both the GoPlus query and the liquidity read SHALL use the reference pair. The evidence SHALL bind both the testnet asset and the reference pair, and the record, policy hash and evidence hash SHALL label it a reference-token audit that did not audit the testnet mock itself. Approval attests the mainnet reference token, not the behaviour of the testnet mock contract.

#### Scenario: Registered mapping
- **WHEN** a registered mock token has passing GoPlus and liquidity evidence for its mainnet reference token
- **THEN** the audit passes labeled as a reference-token audit with both identities bound

#### Scenario: Self-declared or unregistered mapping
- **WHEN** a token declares a reference mapping that is absent from or conflicts with the registry
- **THEN** approval remains Pending without a provider query

#### Scenario: Wrong subject
- **WHEN** GoPlus or liquidity evidence is for the testnet mock itself or another token
- **THEN** it cannot satisfy a reference-token audit

#### Scenario: Unmapped token
- **WHEN** a token has no registry mapping
- **THEN** evidence for any other chain or token cannot approve it

### Requirement: Independent strict liquidity gate
Every community SHALL pass a separate evidence-backed LP check strictly greater than USD 10000. For a reference-token audit the pools SHALL be read on-chain for the mainnet reference token through a read-only mainnet RPC distinct from testnet custody RPC. Only reserves of explicitly configured stablecoins SHALL be valued, at 1 unit = 1 USD. The minimum executable-depth policy for concentrated liquidity SHALL remain OPEN and no value is invented.

#### Scenario: Unlisted quote asset
- **WHEN** a pool's quote asset is not on the configured stablecoin list
- **THEN** the pool is not valued and cannot contribute to the gate

#### Scenario: Concentrated pool
- **WHEN** only a concentrated-liquidity pool is found and no executable depth is established
- **THEN** approval remains Pending

#### Scenario: Threshold equality
- **WHEN** LP value is exactly USD 10000
- **THEN** approval is withheld

#### Scenario: Independent evidence
- **WHEN** GoPlus passes but independent LP evidence is absent
- **THEN** approval remains Pending

### Requirement: Explicit GoPlus field mapping
The auditor SHALL follow the selected field mapping in [GoPlus audit policy](../../../../../goplus-audit.md). It SHALL normalize string flags explicitly, preserve unknowns, interpret tax values as exact decimal fractions and bind evidence to the source chain/token. True `is_honeypot`, `cannot_sell_all` or `cannot_buy` SHALL reject eligibility. A tax fraction of exactly 1 SHALL reject the corresponding trading/custody path. Tax limits and privilege admissibility SHALL follow the versioned owner policy; while that policy is unresolved they stay Pending.

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
- **WHEN** buy tax is "0.05", sell tax is empty and the active policy is unresolved
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
The cron auditor SHALL refresh affected community evidence before lock under a versioned freshness policy (configurable evidence TTL, default 600 seconds, measured from the older of the GoPlus query time and the oldest liquidity observation) and SHALL expose per-field reasons consistently, including a structured report keyed by evidence hash. Live-change recovery policy SHALL remain OPEN until designed.

#### Scenario: Expired or changed evidence
- **WHEN** audit evidence expires or a community/token mapping changes before lock
- **THEN** lock is refused until the affected community satisfies the refreshed audit and separate liquidity gate
