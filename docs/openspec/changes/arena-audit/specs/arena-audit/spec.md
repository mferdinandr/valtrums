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
The audit SHALL apply one versioned policy (`audit-policy-v1`) whose hash changes with any resolved decision. Each tax SHALL be admissible up to and including 0.05 and rejected above it (`tax_above_limit`). The seven admin capabilities SHALL be admissible only with renounced and unrecoverable ownership, else rejected (`admin_privilege_not_renounced`). Unknown fields SHALL stay Pending.

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
A testnet token SHALL be audited through its mainnet (4663) reference token only when a protocol-controlled registry maps it and the same pair is committed in the community mapping. GoPlus and liquidity SHALL both use the reference pair, and the record and hashes SHALL label it a reference-token audit. Approval attests the reference token, not the testnet mock contract.

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
Every community SHALL pass a separate evidence-backed LP check strictly greater than USD 10000. For a reference-token audit the pools SHALL be read on-chain for the mainnet reference token through a read-only mainnet RPC distinct from testnet custody RPC. A pool SHALL be valued only by its quote-side balance at one block, labeled `headline_quote_balance`, an approximation and not executable depth. The minimum executable-depth policy SHALL remain OPEN.

#### Scenario: Unlisted quote asset
- **WHEN** a pool's quote asset is neither a configured stablecoin nor the configured WETH
- **THEN** the pool is not valued and cannot contribute to the gate

#### Scenario: Token-side balance
- **WHEN** a pool holds a large balance of the audited token
- **THEN** that balance adds no value

#### Scenario: WETH quote
- **WHEN** a pool is quoted in WETH and one configured v3 WETH/stablecoin pool is set with its floor met
- **THEN** the WETH balance is priced from that pool at the same block

#### Scenario: Unpriced WETH
- **WHEN** the price pool, its floor or its tokens are unset, unmet or mismatched
- **THEN** the WETH-quoted pool is not counted and approval remains Pending with a reason

#### Scenario: Threshold equality
- **WHEN** LP value is exactly USD 10000
- **THEN** approval is withheld

#### Scenario: Independent evidence
- **WHEN** GoPlus passes but independent LP evidence is absent
- **THEN** approval remains Pending

### Requirement: Explicit GoPlus field mapping
The auditor SHALL follow the selected field mapping in [GoPlus audit policy](../../../../../goplus-audit.md), normalizing flags and tax values explicitly and binding evidence to the source chain/token.

#### Scenario: Critical flags reject
- **WHEN** `is_honeypot`, `cannot_sell_all` or `cannot_buy` is true
- **THEN** eligibility is rejected

#### Scenario: Unknowns and exact decimals
- **WHEN** a value is missing, empty or malformed, or a tax is given as a decimal fraction
- **THEN** the unknown is preserved and never read as zero, and the tax is compared as an exact decimal fraction, never a float

#### Scenario: Limits follow the owner policy
- **WHEN** tax limits or privilege admissibility are evaluated
- **THEN** the versioned owner policy decides, and while it is unresolved the result stays Pending

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

### Requirement: Lock refuses expired or changed approvals
The arena SHALL store, with each audit pass, an expiry taken only from the whitelisted `submit_lifecycle_audit` call, and `lock_lifecycle_battle` SHALL refuse unless every community's approval exists, is before its expiry, binds the committed asset and matches the pinned policy hash when one is set. The agent SHALL send the lock only when every community is approved and fresh.

#### Scenario: Expired approval
- **WHEN** block time is at or after one community's approval expiry
- **THEN** the lock is refused, the battle stays unlocked, and a refreshed pass lets it proceed

#### Scenario: Changed asset or policy
- **WHEN** an approval no longer equals the committed asset, or its policy hash differs from the pinned policy
- **THEN** the lock is refused

#### Scenario: Missing or withdrawn approval
- **WHEN** a community has no approval or a reject or pending result withdrew it
- **THEN** the lock is refused

#### Scenario: Invalid expiry on submission
- **WHEN** a pass has no expiry, one not in the future, or one more than 24 hours ahead
- **THEN** the submission is refused and no approval is stored

#### Scenario: Repeated refresh and lock
- **WHEN** the same pass is submitted again, or lock is called on a locked battle
- **THEN** the call is harmless and a locked snapshot is unchanged, including after the expiry has passed

#### Scenario: Agent lock
- **WHEN** every record is a pass with enough life left
- **THEN** the agent sends the lock once with a deposit of at least 1 yocto plus storage, and a failure is retried after a backoff with a bounded error

