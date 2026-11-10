## ADDED Requirements

### Requirement: Multi-community asset-bound lifecycle UX
Lifecycle selection and creation SHALL support at least two communities up to verified deployment limits, with chain/token/representation/custody/reference identities and actual mode wire values. Asset discovery SHALL use backend search. Legacy A/B economics SHALL remain a separate protocol adapter.

#### Scenario: Three communities are supported
- **WHEN** a verified deployment supports three selected asset identities
- **THEN** the create/detail UI retains all three identities without flattening them into token A/token B

### Requirement: Capability-gated wallet preparation
The client SHALL prepare only exported, verified lifecycle/backing methods with reviewed storage and integer-amount requirements. It SHALL distinguish creation storage, position storage and actual stake, and SHALL NOT attach the legacy USDC proposal bond or variable-duration semantics to lifecycle creation.

#### Scenario: Player registers storage
- **WHEN** a wallet confirms lifecycle position storage registration
- **THEN** the UI records storage readiness without increasing the player's deposited stake

### Requirement: Deposit credit follows backing evidence
The client SHALL bind supported receipt, representation and deposit steps to the verified asset and beneficiary. Submission of a source custody transaction SHALL remain pending until trusted verification and confirmed backing/deposit records establish credit. The client SHALL NOT act as custody operator.

#### Scenario: Source transfer is pending verification
- **WHEN** the wallet submits a custody transfer but no accepted receipt exists
- **THEN** the UI shows verification pending and does not display credited battle stake

### Requirement: Authoritative rounds drive arena presentation
The integrated arena SHALL derive candidates, interval, overtime and results from authoritative lifecycle records with provenance. Missing history/scores SHALL remain unavailable. Timers, chart leaders and 3D interactions SHALL NOT independently resolve rounds or change financial state.

#### Scenario: Round countdown ends before evidence arrives
- **WHEN** the displayed interval expires without a recorded outcome
- **THEN** the scene shows awaiting resolution without fabricating an elimination, winner or overtime

### Requirement: Recoverable and accessible lifecycle interaction
The client SHALL preserve action identity and selections across rejection/retry, reconcile confirmed state before retrying and keep essential status/actions usable with reduced motion or failed WebGL. Unsupported audit/custody/readiness capabilities SHALL block affected actions with specific reasons.

#### Scenario: WebGL fails during a pending deposit
- **WHEN** the scene cannot render while a transaction is pending
- **THEN** a readable fallback retains deposit status and reconciliation controls without resubmitting automatically

### Requirement: Verified deployment and spendable custody
The client SHALL require compatible lifecycle activation and a verified custody-to-payout path before enabling source transfers. A deposit-only test contract or adapter switch SHALL NOT establish those capabilities. Existing audit expiry fields SHALL be consumed without pretending they are missing.

#### Scenario: Deposit-only custody is configured
- **WHEN** the configured custody has no verified reservation-bound payout path
- **THEN** source-transfer controls remain disabled with a custody compatibility reason even when contract reads succeed

### Requirement: Reviewed, session-bound wallet actions
The client SHALL enable wallet signing of lifecycle actions only on a deployment that opts in, SHALL take the signing message and recipients from the read service, SHALL keep the session token in memory only, and SHALL NOT request any authorization until the service's canonical preview equals the call the user reviewed.

#### Scenario: The service's preview differs from the reviewed call
- **WHEN** the canonical preview names another account, contract, method, arguments or deposit than the reviewed call
- **THEN** the flow stops before the wallet is asked to authorize and shows why

#### Scenario: The wallet rejects or the receipt is not verified
- **WHEN** the user rejects a prompt, or a transaction was submitted but no verified receipt exists
- **THEN** the review stays intact for a retry and no battle is reported as created
