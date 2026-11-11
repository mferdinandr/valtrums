## ADDED Requirements

### Requirement: Multi-community asset-bound lifecycle UX

Lifecycle detail SHALL show every community up to verified deployment limits, with chain/token/representation/custody/reference identities and actual mode wire values. Asset discovery SHALL use backend search. Legacy A/B economics SHALL remain a separate protocol adapter.

#### Scenario: Three communities are supported

- **WHEN** a battle holds three asset identities
- **THEN** the detail UI retains all three identities without flattening them into token A/token B

### Requirement: Open arena create, join and cancel

Creation SHALL take one mode and a start time between now + 60 s and now + 7 days, without choosing communities. Before the start the client SHALL let a user join with an allowlisted token, then deposit, and SHALL show a countdown and entered versus pending communities. A cancelled battle SHALL offer each depositor a refund; cancel SHALL be offered only when allowed (D34 to D36).

#### Scenario: Join then deposit

- **WHEN** a user picks an allowlisted token on an open battle before its start
- **THEN** the client previews the join first and offers the deposit only after the join is confirmed and the community is approved

#### Scenario: Start time passes with one funded community

- **WHEN** the start has passed, the battle is unlocked and fewer than two communities are funded
- **THEN** the client offers cancel, and after a confirmed cancel shows the battle as cancelled with a refund action for each funded position

#### Scenario: Battle without a start time

- **WHEN** a battle has no start time
- **THEN** the client shows no countdown, cancel or refund action

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

#### Scenario: A lifecycle battle is opened in the toy-world arena

- **WHEN** lifecycle state contains a recorded interval, candidates or winner
- **THEN** the shared 3D renderer shows those transitions through a lifecycle adapter while timers, selection and decorative attacks cannot create a result

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

#### Scenario: The draft changes while a preview or wallet preparation is in flight

- **WHEN** an asset, mode, reviewed call, account or deployment changes, including changing back to an earlier draft
- **THEN** the previous preview and its late responses cannot enable authorization or broadcasting for the new draft

### Requirement: Coherent lifecycle navigation

Application-mode navigation SHALL use the lifecycle creation/detail routes and SHALL NOT offer blocked legacy-only destinations as core player actions. Technical transaction and evidence details SHALL remain accessible without dominating the player-facing flow.

#### Scenario: Application navigation offers creation

- **WHEN** the application deployment is selected
- **THEN** Create links open the lifecycle creation route and essential navigation does not send the player to blocked legacy pages
