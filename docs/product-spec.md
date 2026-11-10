# Permissionless Robinhood arena: product specification

Status: **planned, not implemented**. Target networks: **NEAR testnet and Robinhood Chain testnet**. This is the product source of truth for the redesign. [Current state](current-state.md) describes the code at the PR base; [OpenSpec](openspec/README.md) is the proposed implementation contract. No mainnet launch, application change, deployment or migration is included here.

## Product and four hackathon tracks

Valtrum lets two or more token communities compete in short rounds. Players stake a community's token, the creator chooses one of four scoring modes, and participants on the final winning community receive the original losing tokens on Robinhood. The winner's own principal goes to DAO escrow for a burn or return decision.

The selected [NEAR Hackathon tracks](https://nearhackathon.com/#tracks) are:

| Hackathon track | Target demonstration |
| --- | --- |
| Memecoins With Mechanics | Token-community battles, explicit prize rules and DAO-directed source-token burn |
| Games With Real Economies | Four scoring modes, locked vaults, native-token rewards and unlimited overtime |
| Social Money | Proportional community entitlements and collective disposition of winning principal |
| AI Swarms | Multiple user-funded NEAR AI player agents competing under bounded policies through shared MCP tools |

All target demonstrations are planned. Track selection does not assert award eligibility or completed functionality. Demonstrate AI Swarms with at least two independently user-funded player agents interacting with the shared arena through MCP under their own budgets and permissions. Strategy can differ; infrastructure workers are not counted as player agents.

Technical workstreams (chain abstraction, scoring/settlement, player AI, and intent terminal/MCP) are implementation groupings supporting these tracks. The DAO rules are decided separately (D22, [DAO governance](dao-governance.md)).

## Actors and authority

| Actor | Responsibility and limits |
| --- | --- |
| Creator | Any user or the protocol can create a battle, choose communities and one mode, and participate with a real positive token deposit before round 1 |
| Player | Deposits an approved community token; earns losing-token rewards only through a position in the final winning community |
| Protocol creator | Follows the same audit, deposit and locking rules; receives the full configured fee instead of splitting it with a creator |
| Player agent | Acts for one user using explicitly delegated funds, methods, destinations, time and spending limits |
| Infrastructure workers | Audit, collect observations, schedule rounds, index events and relay authorized payouts; cannot spend a player's wallet or delegated player budget |
| Asset custody / representation contracts | Verify receipts, mint only backed amounts, reserve and consume backing once |
| DAO | The final winning community's participants vote, weighted by principal, to burn (to a verified sink) or return winning principal; see [DAO governance](dao-governance.md) |
| Operator | Maintains services, gas and observability under documented privileges; cannot silently change a locked battle's rules |

Permissionless creation does not mean permissionless oracle submissions or unrestricted foreign-chain signing. Those are authenticated infrastructure responsibilities with the trust assumptions in [security-review.md](security-review.md).

## Required lifecycle

1. **Proposed / audit pending.** The creator selects at least two distinct token communities and exactly one scoring mode. Identity includes chain and token contract, never ticker alone. There is **no proposal bond**. Audit and backing verification must finish before approval.
2. **Approved / gathering.** Players deposit real assets credited only after verified receipt. The creator, including a protocol creator, must have a positive backed position in one participating community. Gas, fees, promises to fund and an infrastructure wallet balance are not participation.
3. **Locked.** Before round 1, freeze the community set, token mapping, mode, position amounts, vault totals, recipients, fee beneficiary identity and observation policy. Each community must have a positive vault, and creator participation must be verified. In-flight deposits cannot change this snapshot; they must remain recoverable outside it. An invalid snapshot cannot start.
4. **Round live.** Capture valid start observations and run a **30-second** round. Prices are point observations; **no TWAP** is used. Late scheduler execution must not shift the already recorded interval or use its current price as the scheduled close.
5. **Round resolution.** A unique best score produces the final winner. If the best score is tied, only those tied leaders enter another 30-second round. Reset all score inputs, including volume and drawdown peaks, for that new round. There is no overtime cap.
6. **Overtime.** Deposits stay closed. All original vaults, including eliminated communities, remain locked until one final winner is determined. A tie does not refund, distribute fees or release an eliminated vault.
7. **Settlement allocation.** Each losing vault uses the fee and creator share snapshotted at creation. Defaults are 99.9% to winners, 0.05% to creator and 0.05% to protocol. Protocol can adjust the total fee and creator share for future battles; a protocol-created battle allocates its entire configured fee to protocol. Final-winner participants share each losing token in proportion to their locked winning-token units.
8. **Payout and escrow proceed independently.** Losing-token entitlements become available without waiting for the DAO. They are paid as those original assets on Robinhood, not swapped into the winner's token or USDC. Winning principal is placed in DAO escrow; no automatic return or burn is implied. Available entitlement, pending transfer and confirmed receipt are separate statuses.

The pre-lock scheduling window, cancellation/refund policy and response to invalid live observations require implementation design (OPEN below). They cannot create an implicit tie refund or an overtime limit.

## Four selectable scoring modes

| Creator's selection | Winner comparison | Required observations |
| --- | --- | --- |
| Price % Gain | Highest signed percentage price change | Start and end price |
| Market Cap % Growth | Highest signed percentage change of price × circulating supply | Start/end price and circulating supply |
| Volume-to-Market Cap Ratio | Highest round quote-volume divided by initial market cap | Round volume and initial price/supply |
| Lowest % Drawdown | Lowest maximum peak-to-trough price drawdown over the round | Ordered price observations including start/end |

Use [battle-rules.md](battle-rules.md) for exact formulas, negative scores, ties and observation validity. A negative score can win. Fully observed zero drawdown is valid; missing samples are not zero risk.

## Asset and audit requirements

Representations are NEP-141 tokens backed **1:1 by actual Robinhood assets received**, with documented decimal normalization. Claimed deposits, unconfirmed receipts or a transfer's nominal input cannot mint additional backing. Settlement, redemption and DAO burns share one liability ledger so the same backing cannot be redeemed and paid out again. See [token-economics.md](token-economics.md).

Approval requires GoPlus checks that reject critical risks, plus an independent LP check **strictly greater than USD 10,000** for each community. Missing mandatory data, unsupported chain coverage, stale evidence or unresolved required policy yields **Pending**, never Pass. A critical finding yields Reject. Do not replace GoPlus with the existing DexScreener heuristic. Audit policy v1 (owner decision, 2026-11-07, see the [decision log](findings-and-decisions.md)): buy, sell and transfer tax must each be at most 5% (a tax of exactly 100% still rejects), and privileged token administration (mint, pause, blacklist or whitelist, balance changes, tax changes) is admissible only when ownership is renounced and unrecoverable, otherwise Reject. Evidence lifetime defaults to 10 minutes and is configurable. On testnet each mock token is audited through its Robinhood mainnet reference token (chain 4663), and approval attests that reference token, not the mock contract. The selected [GoPlus field mapping and decision precedence](goplus-audit.md) define critical rejection and required evidence. Behavior after a live token-policy change stays **OPEN**. Version the mapping and policy before live approval can be enabled.

## Acceptance scenarios

| Scenario | Required result |
| --- | --- |
| Two communities; A has the higher price gain | A wins; B's original token is allocated under the snapshotted fee (99.9/0.05/0.05 at defaults); A principal enters DAO escrow |
| Three communities; A wins over B and C | Both B and C are losing vaults; A participants receive two separate token entitlements |
| Protocol creates a battle | A real protocol position is locked; every losing token charges its configured fee to the protocol and no additional creator fee |
| Best price scores are -5%, -10%, -20% | -5% wins; losses are not clamped to zero |
| All observed prices are nondecreasing | Maximum drawdown is zero; equal best zero scores enter overtime |
| A/B tie twice; C was eliminated in round 1 | A/B compete with fresh inputs each time; C's vault stays locked; no new deposit is accepted |
| LP is exactly USD 10,000 or GoPlus data is incomplete | No approval; LP must exceed the threshold and mandatory evidence must be complete |
| A transfer is nominally 100 units but custody receives 98 | Mint/credit at most 98 units, subject to audit policy; never pretend 100 arrived |
| A payout's receipt response is lost after broadcast | Reconcile the same payout identity, nonce and transaction before retry; the recipient cannot be paid twice |
| DAO remains undecided | Winning principal stays escrowed while losing-token rewards can be paid |
| A tiny vault creates rounding remainders | Follow the deterministic per-token allocation; all integer units remain accounted for |

## OPEN QUESTION register

| ID | Question / gate | Consequence until decided |
| --- | --- | --- |
| OQ-DAO | Decided 2026-11-08 (D22, [DAO governance](dao-governance.md)): winners vote, weighted by principal; pro-rata burn/return split of votes cast applied to the whole escrow; no quorum or delegation; window opens at the final winner, length protocol-adjustable and snapshotted; no votes means it stays escrowed; contract tally, anyone executes; burn = verified sink transfer. Open: default window value, per-token sink address | Until implemented, winning principal remains escrowed; any demo decision must be labeled a fixture |
| OQ-AUDIT | Behavior after a live token-policy change and minimum executable liquidity depth. Decided 2026-11-07 (audit policy v1): tax at most 5% each, admin privileges only with renounced and unrecoverable ownership, evidence lifetime 10 minutes and configurable; field mapping is defined in [GoPlus audit policy](goplus-audit.md). Minimum executable liquidity depth decided 2026-11-09 (D32): the headline policy is kept for the hackathon and the limit is documented | No invented live-change refund or recovery rule; unresolved required checks remain Pending |
| OQ-DATA | Providers for price, circulating supply, 30-second volume, sampling cadence, boundary tolerance and anti-manipulation checks. LP valuation is decided as an on-chain headline quote-side balance on the mainnet reference token (see the [decision log](findings-and-decisions.md)); scoring data for mock tokens is expected to use the reference token too and is not yet specified | Freeze a reproducible policy before locking; missing data cannot determine a winner |
| OQ-CUSTODY | Receipt verifier, custody contracts, confirmations/finality, reorg recovery, payout gas and tax handling, burn proof | No trusted bridge or Robinhood support may be assumed from signing compatibility alone |
| OQ-LIFECYCLE | Gathering deadline, cancellation/refunds before lock, outage recovery and emergency authority | Do not auto-refund a live tie or release a vault on elapsed time |
| OQ-IDENTITY | Protocol-creator authorization, destination binding and multiple-community positions per account | Specify and enforce identity rules before accepting funds; do not infer protocol status from a display name |
| OQ-LIMITS | Token/position/storage limits, scheduler latency budget and who pays operational costs | Bound execution without limiting the agreed unlimited sequence of overtime rounds |
| OQ-INTEGRATIONS | GoPlus Robinhood testnet coverage, Intents routes, NEAR AI access and signer compatibility | Record actual evidence; unsupported integrations block the corresponding live acceptance claim |

The [roadmap](implementation-roadmap.md) orders these gates. This proposal replaces earlier swap settlement, TWAP, bond and credit plans for the target arena. Existing deployments retain their existing rules until an explicitly implemented migration; this PR performs none.
