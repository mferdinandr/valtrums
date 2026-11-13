# Permissionless token-community arena: product specification

Status: **implemented on testnet** (see [current state](current-state.md)). Network: **NEAR testnet**; Robinhood Chain mainnet is only read for prices and token audits. This is the product source of truth for the redesign. [Current state](current-state.md) describes what runs today; [OpenSpec](openspec/README.md) holds the implementation changes. No mainnet launch is included.

## Product and four hackathon tracks

Valtrum lets two or more token communities compete in short rounds in an open arena that any allowlisted community can join before its start time. Players stake a community's token, the creator chooses one of four scoring modes, and participants on the final winning community receive the losing tokens themselves, claimed into their NEAR wallet. The winner's own principal goes to DAO escrow for a burn or return decision.

The selected [NEAR Hackathon tracks](https://nearhackathon.com/#tracks) are:

| Hackathon track | Target demonstration |
| --- | --- |
| Memecoins With Mechanics | Token-community battles, explicit prize rules and DAO-directed source-token burn |
| Games With Real Economies | Four scoring modes, locked vaults, native-token rewards and unlimited overtime |
| Social Money | Proportional community entitlements and collective disposition of winning principal |
| AI Swarms | Multiple user-funded NEAR AI player agents competing under bounded policies through shared MCP tools |

Track selection does not assert award eligibility; see the README for what each track has shown live. Demonstrate AI Swarms with at least two independently user-funded player agents interacting with the shared arena through MCP under their own budgets and permissions. Strategy can differ; infrastructure workers are not counted as player agents.

Technical workstreams (chain abstraction, scoring/settlement, player AI, and intent terminal/MCP) are implementation groupings supporting these tracks. The DAO rules are decided separately (D22, [DAO governance](dao-governance.md)).

## Actors and authority

| Actor | Responsibility and limits |
| --- | --- |
| Creator | Any user or the protocol can create an open battle with one mode and a start time, and must participate with a real positive token deposit before the lock (D34) |
| Player | Deposits an approved community token; earns losing-token rewards only through a position in the final winning community |
| Protocol creator | Follows the same audit, deposit and locking rules; receives the full configured fee instead of splitting it with a creator |
| Player agent | Acts for one user using explicitly delegated funds, methods, destinations, time and spending limits |
| Infrastructure workers | Audit, collect observations and schedule rounds; cannot spend a player's wallet or delegated player budget |
| Community token contracts | Hold balances, entitlements, escrow and burns in one ledger; consume each unit once |
| DAO | The final winning community's participants vote, weighted by principal, to burn (destroyed on NEAR) or return winning principal; see [DAO governance](dao-governance.md) |
| Operator | Maintains services, gas and observability under documented privileges; cannot silently change a locked battle's rules |

Permissionless creation does not mean permissionless oracle submissions or unrestricted foreign-chain signing. Those are authenticated infrastructure responsibilities with the trust assumptions in [security-review.md](security-review.md).

## Required lifecycle

1. **Open / gathering.** The creator picks exactly one scoring mode and a start time between now + 60 seconds and now + 7 days; communities are not invited (D34). There is **no proposal bond**. Before the start, anyone joins with a token on the protocol allowlist (D35: CASHCAT, WALLET, GOOD, VLAD, DEGEN), which adds its community. Identity includes chain and token contract, never ticker alone. A community counts as entered only once it holds a deposit.
2. **Deposits.** Players deposit real assets credited only after verified receipt and only when the target community has fresh audit and backing approvals (D37). The creator, including a protocol creator, must have a positive backed position in one participating community. Gas, fees, promises to fund and an infrastructure wallet balance are not participation. Joining and deposits close at the start time.
3. **Locked.** At or after the start time, with at least two funded communities, freeze the funded community set, token mapping, mode, position amounts, vault totals, recipients, fee beneficiary identity and observation policy. Every funded community needs fresh approvals; empty communities are excluded. Creator participation must be verified. In-flight deposits cannot change this snapshot; they must remain recoverable outside it. An invalid snapshot cannot start. If fewer than two communities are funded after the start, anyone may cancel and each depositor pulls a refund (D36).
4. **Round live.** Capture valid start observations and run a **30-second** round. Prices are point observations; **no TWAP** is used. Late scheduler execution must not shift the already recorded interval or use its current price as the scheduled close.
5. **Round resolution.** A unique best score produces the final winner. If the best score is tied, only those tied leaders enter another 30-second round. Reset all score inputs, including volume and drawdown peaks, for that new round. There is no overtime cap.
6. **Overtime.** Deposits stay closed. All original vaults, including eliminated communities, remain locked until one final winner is determined. A tie does not refund, distribute fees or release an eliminated vault.
7. **Settlement allocation.** Each losing vault uses the fee and creator share snapshotted at creation. Defaults are 99.9% to winners, 0.05% to creator and 0.05% to protocol. Protocol can adjust the total fee and creator share for future battles; a protocol-created battle allocates its entire configured fee to protocol. Final-winner participants share each losing token in proportion to their locked winning-token units.
8. **Rewards and escrow proceed independently.** Losing-token entitlements are recorded without waiting for the DAO, but the battle page opens the claim only once the DAO decision is finished (D45). The holder claims them as tokens in their NEAR wallet (D44), not swapped into the winner's token or USDC. Winning principal is placed in DAO escrow; no automatic return or burn is implied.

The pre-lock scheduling window and cancellation/refund policy are decided for start-time battles (D34, D36). The response to invalid live observations requires implementation design (OPEN below). They cannot create an implicit tie refund or an overtime limit.

## Four selectable scoring modes

| Creator's selection | Winner comparison | Required observations |
| --- | --- | --- |
| Price % Gain | Highest signed percentage price change | Start and end price |
| Market Cap % Growth | Highest signed percentage change of price × circulating supply | Start/end price and circulating supply |
| Volume-to-Market Cap Ratio | Highest round quote-volume divided by initial market cap | Round volume and initial price/supply |
| Lowest % Drawdown | Lowest maximum peak-to-trough price drawdown over the round | Ordered price observations including start/end |

Use [battle-rules.md](battle-rules.md) for exact formulas, negative scores, ties and observation validity. A negative score can win. Fully observed zero drawdown is valid; missing samples are not zero risk.

## Asset and audit requirements

Community tokens are NEP-141 tokens on NEAR. A deposit is credited only for what the arena actually receives. Settlement, claims and DAO burns share one ledger per token, so the same units cannot be rewarded, refunded and burned twice. See [token-economics.md](token-economics.md).

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
| A transfer is nominally 100 units but the arena receives 98 | Credit at most 98 units; never pretend 100 arrived |
| DAO remains undecided | Winning principal stays escrowed while losing-token rewards can be paid |
| A tiny vault creates rounding remainders | Follow the deterministic per-token allocation; all integer units remain accounted for |
| Start time passes with only one funded community | Anyone cancels; each depositor pulls back exactly their credited units; no round, fee or entitlement |
| Three communities joined, one never funded | The lock runs over the two funded communities; the empty one plays no round |
| A community joins after creation | Its losing vault uses the fee and creator share snapshotted at creation (D38) |

## OPEN QUESTION register

| ID | Question / gate | Consequence until decided |
| --- | --- | --- |
| OQ-DAO | Decided 2026-11-08 (D22, [DAO governance](dao-governance.md)): winners vote, weighted by principal; pro-rata burn/return split (each vote sets its own burn percentage, weighted average, D43) applied to the whole escrow; no quorum or delegation; window opens at the final winner, length protocol-adjustable and snapshotted; no votes means it stays escrowed; contract tally, anyone executes; the burned share is destroyed on NEAR. Implemented and run live. Open: default window value | If nobody votes, winning principal remains escrowed |
| OQ-AUDIT | Behavior after a live token-policy change and minimum executable liquidity depth. Decided 2026-11-07 (audit policy v1): tax at most 5% each, admin privileges only with renounced and unrecoverable ownership, evidence lifetime 10 minutes and configurable; field mapping is defined in [GoPlus audit policy](goplus-audit.md). Minimum executable liquidity depth decided 2026-11-09 (D32): the headline policy is kept for the hackathon and the limit is documented | No invented live-change refund or recovery rule; unresolved required checks remain Pending |
| OQ-DATA | Providers for price, circulating supply, 30-second volume, sampling cadence, boundary tolerance and anti-manipulation checks. LP valuation is decided as an on-chain headline quote-side balance on the mainnet reference token (see the [decision log](findings-and-decisions.md)); scoring data for mock tokens is expected to use the reference token too and is not yet specified | Freeze a reproducible policy before locking; missing data cannot determine a winner |
| OQ-LIFECYCLE | Outage recovery and emergency authority. Decided 2026-11-11 (D34, D36): the gathering deadline is the creator's start time, and below two funded communities after the start anyone cancels and depositors pull refunds; battles without a start time cannot be cancelled. Open: a funded community whose approval lapses blocks the lock and the cancel | Do not auto-refund a live tie or release a vault on elapsed time |
| OQ-IDENTITY | Protocol-creator authorization, destination binding and multiple-community positions per account | Specify and enforce identity rules before accepting funds; do not infer protocol status from a display name |
| OQ-LIMITS | Token/position/storage limits, scheduler latency budget and who pays operational costs | Bound execution without limiting the agreed unlimited sequence of overtime rounds |
| OQ-INTEGRATIONS | GoPlus coverage of the Robinhood mainnet reference tokens and NEAR AI access | Record actual evidence; unsupported integrations block the corresponding live acceptance claim |

The [roadmap](implementation-roadmap.md) orders these gates. This proposal replaces earlier swap settlement, TWAP, bond and credit plans for the target arena. Existing deployments retain their existing rules until an explicitly implemented migration; this PR performs none.
