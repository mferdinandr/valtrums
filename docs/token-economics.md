# Token economics and settlement

Status: **implemented on NEAR testnet**. Everything below happens on NEAR; no value moves to or from another chain. All balances are integers in the asset's declared smallest unit. No conversion of losing-token rewards to USDC or the winner token is part of this design. [Current-state economics](current-state.md) remain historical implementation behavior.

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

Protocol configures total `fee_bps` between 0 and 1,000 inclusive (a 10% ceiling) and `creator_share_bps` between 0 and 10,000 inclusive, independently. Defaults are 10 bps (0.1%) and 5,000 bps (50% of fee). Snapshot both values and protocol recipient when a battle is created; changes affect future battles only. Use checked wide arithmetic. Protocol-created battles pay the whole fee to protocol.

1. Compute `fee_j = floor(L_j * fee_bps / 10000)` once for each losing token. The fractional fee remainder stays with winners: `Q_j = L_j - fee_j`.
2. For a user-created battle, `creator_fee_j = floor(fee_j * creator_share_bps / 10000)` and `protocol_fee_j = fee_j - creator_fee_j`. The protocol receives the remainder after creator rounding. For a protocol-created battle, `creator_fee_j = 0` and `protocol_fee_j = fee_j`.
3. Do not use largest remainder to apportion reward versus revenue: it must never increase the total fee above `floor(L_j * fee_bps / 10000)`.
4. Within `Q_j` only, allocate among winning beneficiaries using `floor(Q_j * d_u / C_W)`, then distribute remaining units by descending fractional remainder. Break equal remainders by canonical NEAR beneficiary account ID bytes in ascending order.
5. Aggregate a beneficiary's winning deposits before calculating their share. Snapshot the ordered beneficiary list so pagination or claim order cannot affect dust.

Percentages describe ideal amounts; indivisible units approximate them. At the default fee, a vault below 1,000 atomic units pays zero fee. Do not round each claim independently or allocate all dust to the last caller.

For every losing token independently:

`L_j = Q_j + creator_fee_j + protocol_fee_j`

`Q_j = sum_u reward_(u,j)`.

The final winning principal `C_W` is separately conserved in DAO escrow. There is no meaningful sum of different tokens without a valuation; never use a USD total as the conservation check.

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

B and C remain different tokens through allocation and claim. No swap price is needed.

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

## Community tokens

Each community is one NEP-141 token contract on NEAR (`backing-<token>.valtrum-owner-b694.testnet`), identified by its account, never by ticker. Deposits are `ft_transfer_call` to the arena; the arena credits only the units it actually receives. Standard transfers cannot bypass vault, entitlement or DAO locks.

## Per-token ledger

Each token contract keeps one ledger, read with `get_ledger`:

- **Live supply:** tokens in wallets and in the arena, including locked vaults.
- **Entitlements:** rewards and returned principal waiting to be claimed.
- **Escrow:** winning principal waiting for the winners' vote.
- **Burned:** the share the winners' vote destroyed; it never returns to the supply.

The contract checks that these balance (`accounting_balanced`).

| Transition | Ledger change |
| --- | --- |
| Deposit or lock a vault | Ownership changes inside the live supply |
| Allocate losing vault q | q leaves the live supply (burned from the arena) and becomes entitlements for the beneficiaries |
| Claim q | Entitlements decrease by q; q is minted to the claimer's wallet |
| Escrow the winning principal q | q leaves the live supply and is held in escrow |
| Winners' vote returns r | Escrow decreases by r; entitlements increase by r |
| Winners' vote burns b | Escrow decreases by b; b is recorded as burned and never minted again |

Each transition runs once per allocation, escrow or release id. Migration of old credit/WAR/VALT liabilities is out of scope.

## Entitlement and claim

At settlement, a winner's losing-token rights are **entitlements**. The battle page opens the claim once the winners' vote has finished (D45); the holder then claims them into their NEAR wallet with `claim_entitlement_as_representation`. One token's claim never depends on another's.

## DAO principal escrow

The winner's principal remains in escrow for the winners' vote. Losing-token rewards and revenue are recorded independently at allocation.

Governance is decided (D22, see [DAO governance](dao-governance.md)): the winning community's participants vote burn or return, weighted by their principal; the burn share of votes cast applies to the whole escrow (per holder `burn_i = floor(p_i * B / (B + R))`, `return_i = p_i - burn_i`, so conservation is exact and rounding favours return). There is no quorum and no delegation. If nobody votes in the window, the principal stays escrowed, and no timeout may silently return or burn it.

The burned share is destroyed on NEAR: it is recorded once in the ledger and never minted again. The same units cannot subsequently be returned or claimed.

## Required accounting checks

Implementation tests must cover per-token conservation, all fee recipients, creator participation on either outcome, two/three communities, protocol creation, tiny and uneven vaults, deterministic dust, short deposits credited for what arrived, concurrent claim/settlement/burn attempts and repeated executions without a duplicate effect. See [OpenSpec assets](openspec/changes/arena-asset-representation/specs/arena-asset-representation/spec.md) and [settlement](openspec/changes/arena-settlement/specs/arena-settlement/spec.md).
