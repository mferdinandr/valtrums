# Token economics, backing and settlement

Status: **planned**. All balances are integers in the asset's declared smallest unit. No conversion of losing-token rewards to USDC or the winner token is part of this design. [Current-state economics](current-state.md) remain historical implementation behavior.

## Per-token distribution

For final winner community W, let `C_W > 0` be its locked token units and `d_u` the units of participant u in W. The participant weight is `d_u / C_W`, using actual credited winning-token deposits, not USD value, vote weight or an agent's nominal transfer amount.

At default fee settings, for **each** losing community j with locked vault `L_j`:

| Beneficiary | User-created battle | Protocol-created battle |
| --- | --- | --- |
| Winning participants, collectively | 99.9% of token j | 99.9% of token j |
| Creator | 0.05% of token j | No separate creator allocation |
| Protocol | 0.05% of token j | Entire 0.1% of token j |

The creator's fee is separate from any reward earned by their winning position. A creator on a losing community still receives the creator fee but loses that position. A protocol creator can earn a proportional player reward through its real winning position as well as protocol revenue. Protocol identity must be authenticated and frozen before lock (policy OPEN); a creator cannot select a display flag to redirect revenue.

All original nonwinning communities are losing vaults, including communities eliminated in earlier overtime rounds. Allocate only after a unique final winner. No fee is charged to winning principal by this rule.

## Integer rounding and conservation

Protocol configures total `fee_bps` and `creator_share_bps` independently between 0 and 10,000 inclusive. Defaults are 10 bps (0.1%) and 5,000 bps (50% of fee). Snapshot both values and protocol recipient when a battle is created; changes affect future battles only. Use checked wide arithmetic. Protocol-created battles pay the whole fee to protocol.

1. Compute `fee_j = floor(L_j * fee_bps / 10000)` once for each losing token. The fractional fee remainder stays with winners: `Q_j = L_j - fee_j`.
2. For a user-created battle, `creator_fee_j = floor(fee_j * creator_share_bps / 10000)` and `protocol_fee_j = fee_j - creator_fee_j`. The protocol receives the remainder after creator rounding. For a protocol-created battle, `creator_fee_j = 0` and `protocol_fee_j = fee_j`.
3. Do not use largest remainder to apportion reward versus revenue: it must never increase the total fee above `floor(L_j * fee_bps / 10000)`.
4. Within `Q_j` only, allocate among winning beneficiaries using `floor(Q_j * d_u / C_W)`, then distribute remaining units by descending fractional remainder. Break equal remainders by canonical NEAR beneficiary account ID bytes in ascending order.
5. Aggregate a beneficiary's winning deposits before calculating their share. Snapshot the ordered beneficiary list so pagination or claim order cannot affect dust.

Percentages describe ideal amounts; indivisible units approximate them. At the default fee, a vault below 1,000 atomic units pays zero fee. Do not round each claim independently or allocate all dust to the last caller. Recipient mapping to Robinhood must be authorized and frozen before a payout is signed.

For every losing token independently:

`L_j = Q_j + creator_fee_j + protocol_fee_j`

`Q_j = sum_u reward_(u,j)`.

The final winning principal `C_W` is separately conserved in DAO escrow. There is no meaningful sum of different tokens without a valuation; never use a USD total as the custody conservation check.

The examples below use the initial default fee settings.

### Two-community example

A has 1,000 locked A units: Alice 600, Bob 400. B has 100,000 B base units. A wins a user-created battle.

| Allocation | B base units |
| --- | --- |
| Alice reward | 59,940 |
| Bob reward | 39,960 |
| Creator fee | 50 |
| Protocol fee | 50 |
| Total | 100,000 |

The 1,000 A units enter DAO escrow. Alice and Bob can receive B before a DAO decision about A.

### Three-community example

A wins with Alice/Bob weights 25%/75%. B holds 100,000 B units and C holds 200,000 C units.

| Beneficiary | B units | C units |
| --- | --- | --- |
| Alice | 24,975 | 49,950 |
| Bob | 74,925 | 149,850 |
| Creator | 50 | 100 |
| Protocol | 50 | 100 |
| Total | 100,000 | 200,000 |

B and C remain different assets through allocation and Robinhood payment. No swap price is needed.

### Protocol creator and rounding examples

For a protocol-created battle with 100,000 losing units, winners collectively receive 99,900 and protocol revenue is 100, not 100 plus another 50.

The fee is taken once per token, before participant allocation:

| Losing vault units | Total fee | Winner pool | User creator | Protocol (user-created) | Protocol (protocol-created) |
| --- | --- | --- | --- | --- | --- |
| 999 | 0 | 999 | 0 | 0 | 0 |
| 1,000 | 1 | 999 | 0 | 1 | 1 |
| 10,003 | 10 | 9,993 | 5 | 5 | 10 |
| 100,000 | 100 | 99,900 | 50 | 50 | 100 |

For 1,000 units, independently flooring two nominal 0.05% fees would incorrectly collect zero. Taking 0.1% first collects exactly one unit. For 999 units, category largest remainder must not round the total fee up to one unit.

For a 9,993-unit reward pool and Alice/Bob/Carol weights 1:2:3, ideals are 1,665.5 / 3,331 / 4,996.5. One remaining unit goes to Alice by the account-ID tie order: **1,666 / 3,331 / 4,996**, totaling 9,993. Implementations must use canonical account IDs rather than these display names.

## 1:1 representation and custody

Each token identity binds Robinhood chain ID, token contract address, NEAR representation account, decimals and custody domain. No symbol-based mapping. A valid deposit needs finalized evidence of the actual custody increase, recipient/battle attribution and a unique source receipt identity such as `(chain_id, tx_hash, log_index)`, reconciled against balance changes. Prevent donation contamination, replay and crediting unrelated transfers.

Mint only the verified received amount after exact normalization. If a sender attempts 100 and custody receives 98, no more than 98 can be represented. That arithmetic does not approve a taxed token: admissibility and outbound tax handling remain OPEN. Never mint from a user declaration, an MPC signature or an unconfirmed transaction.

Prefer identical atomic-unit precision on both chains. If decimals differ, specify an exact reversible unit mapping and keep unrepresentable residual units as explicitly attributed unallocated custody; never round minted value up. Tests must prove normalization at minimum/maximum amounts.

NEP-141 defines transfer behavior, not a bridge, a universal burn method or proof of Robinhood backing. The planned representation contract needs controlled receipt-based minting and an explicit redemption/burn lifecycle. Standard transfers cannot bypass vault, entitlement or DAO locks.

## Liability ledger

For each asset, express all entries in the same canonical custody units:

- `B`: verified actual custody balance.
- `M`: backing assigned to live representation supply, including representations locked in battle or DAO escrow.
- `E`: allocated but not yet submitted native-token entitlements, including rewards and revenue.
- `P`: exclusively reserved pending native payouts/redemptions whose corresponding representations or entitlements are no longer spendable.
- `D`: exclusively reserved pending DAO-directed underlying disposal after representations are disabled/burned.
- `U`: verified unallocated custody, with attribution and recovery policy; it cannot silently become revenue.

The accounting invariant is `B = M + E + P + D + U` for reconciled supported assets. During cross-chain evidence delay, retain the previous liability and show reconciliation pending; do not present a fresh unverified balance as satisfying the invariant. Unexpected deficits stop new minting and affected payouts pending investigation.

| Transition | Ledger change |
| --- | --- |
| Verify q custody units, then mint q | B and M increase by q; the receipt is consumed once |
| Transfer a representation or lock a vault | Ownership changes inside M; backing does not change |
| Allocate losing vault q | Burn/disable its representations: M decreases by q, E increases by q across all beneficiaries |
| Reserve a payout | E decreases by q, P increases by q; same entitlement cannot be spent again |
| Redeem unlocked representations | Burn/disable q representations: M decreases by q, P increases by q |
| Confirm exact authorized native debit/payment | B and P decrease by q; mark payout identity confirmed |
| Definitively fail without any chain movement | Restore P to E, or restore the disabled representation and M, exactly once; only after reconciliation proves no executable transaction remains |
| DAO chooses verified underlying burn/sink | Consume escrowed representations from M into D; confirm underlying disposal, then reduce B and D by q |
| DAO chooses return | Move escrowed M into a native redemption reservation P or unlock representations according to the approved decision; never do both |

Cross-chain changes are asynchronous; these are logical transitions with durable intermediate records and idempotent reconciliation, not an assertion of atomic execution across chains. Migration of old credit/WAR/VALT liabilities is out of scope.

## Entitlement versus confirmed payout

At settlement, a winner's losing-token rights are **available entitlements**, not evidence of a foreign transfer. The UI/API distinguishes available, reserved, signature pending, broadcast, confirmation pending, confirmed, and retry/reconciliation required. A confirmed payout needs verified chain/token, sender, beneficiary, amount, successful execution and finality evidence tied to that payout ID.

For each asset, `allocated = available + in_flight + confirmed_paid`, with confirmed payment records retained for replay protection. Reserve before requesting a signature. Persist payout ID, exact payload hash, custody path, nonce and attempts. A restarted worker must reconcile existing transactions, including replacements, before creating another spend. Re-broadcasting the same signed transaction is safe only under the same identity; a new nonce cannot be used to pay an unresolved claim again.

A signature callback, an RPC acceptance, a transaction hash and an indexer's unfinalized event are not payment confirmation. Failed/slow payouts do not recalculate entitlements or fees. One token's payout failure does not make another token's reward depend on the DAO.

Transfer-tax/rebase behavior can break equality between custody debit and recipient receipt. That policy is OPEN and must be resolved or such assets excluded before live approval; never mark a short receipt fully paid or restore representations after an actual debit. Native gas must have separate funding/accounting; do not silently deduct it from token rewards.

## DAO principal escrow

The winner's principal and its backing remain reserved for DAO disposition. Losing-token rewards and revenue are independent liabilities and can be paid immediately after allocation.

DAO membership, vote weighting, quorum, deadlines, allowed burn/return proportions, fallback, delegation and execution policy are **OPEN**. No timeout may silently return or burn principal. A demo fixture must disclose that it is a fixture, not governance.

Destroying only NEAR representations does not prove Robinhood tokens were burned. A disposal must bind the decision, escrow amount, destination/action and verified underlying result. Whether the underlying token supports a supply burn or requires an irrecoverable sink is OPEN; report these outcomes accurately. The same units cannot subsequently be redeemed or returned.

## Required accounting checks

Implementation tests must cover per-token conservation, all fee recipients, creator participation on either outcome, two/three communities, protocol creation, tiny and uneven vaults, deterministic dust, decimal mismatch, taxed input versus policy, duplicate deposit receipts, concurrent redemption/settlement/burn attempts, partial payout completion, lost callbacks and broadcast retries without duplicate payment. See [OpenSpec assets](openspec/changes/arena-asset-representation/specs/arena-asset-representation/spec.md) and [settlement](openspec/changes/arena-settlement/specs/arena-settlement/spec.md).
