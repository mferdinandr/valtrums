# Implement the permissionless Robinhood arena for the NEAR hackathon

Publication status: **prepared locally; GitHub issue URL pending**. This is the exact parent issue content to publish after checking existing issues/PRs for duplicates.

## Product

Build a permissionless arena on NEAR testnet with original-token custody and payouts on Robinhood Chain testnet. Two or more communities compete in 30-second rounds; winners receive each losing token, and winning principal enters DAO escrow. This issue tracks implementation, not completion of the documentation proposal.

## Specifications

[Product](product-spec.md), [rules](battle-rules.md), [economics](token-economics.md), [architecture](architecture.md), [interfaces](interfaces.md), [ecosystem](ecosystem.md), [GoPlus policy](goplus-audit.md), [deployment](deployment.md), [security](security-review.md), [roadmap](implementation-roadmap.md), [current state](current-state.md), [OpenSpec](openspec/README.md).

When publishing to GitHub, expand these relative links to repository blob links on docs/near-hackathon-arena-spec so they resolve from the issue.

## Selected hackathon tracks

Memecoins With Mechanics, Games With Real Economies, Social Money and AI Swarms. Map evidence to each track; the AI Swarms demo uses multiple independently user-funded player agents, and Social Money preserves the OPEN governance design.

## Final decisions

- At least two communities; freeze communities/deposits before round 1; real positive creator participation including protocol creators; no bond.
- Creator selects Price % Gain, Market Cap % Growth, Volume-to-Market Cap Ratio or Lowest % Drawdown. Market cap is price × circulating supply; volume is round quote-volume / initial market cap; drawdown is maximum peak-to-trough decline.
- Every round is 30 seconds, no TWAP. Tied best candidates repeat with reset inputs without a cap. Deposits stay closed and every original vault stays locked.
- At default settings, each losing token: 99.9% proportional winning-player reward, 0.05% creator and 0.05% protocol; protocol-created battles pay the full 0.1% to protocol.
- Snapshot protocol-configured fee and creator share at battle creation. Collect `floor(losing_vault * fee_bps / 10000)` first; allocate `floor(fee * creator_share_bps / 10000)` to a user creator and the remainder to protocol, or all to protocol for a protocol creator. Largest remainder applies only to participant rewards.
- Payouts remain original losing tokens on Robinhood; distinguish allocated rights from confirmed transfer. Winning principal goes to DAO; rewards do not wait.
- NEP-141 backing is 1:1 actual received assets; exclusive reservations prevent redemption/payout/burn double use.
- GoPlus critical risk rejects, unknown mandatory data holds approval; LP separately must exceed USD 10,000.
- Player agents use bounded user funds/permissions. Infrastructure has no player spending authority.

## OPEN QUESTION

DAO membership, weights, quorum, deadline, execution/fallback; behavior after a live token-policy change (minimum executable liquidity depth decided in D32, 2026-11-09) (tax/admin policy v1 and evidence lifetime are decided; see the [decision log](findings-and-decisions.md) and [GoPlus policy](goplus-audit.md)); oracle providers/cadence/boundaries/supply; custody proof/finality/reorgs/gas/tax/burn; pre-lock cancellation and outage response; protocol identity and position rules. Preserve the [full question register](product-spec.md#open-question-register); do not decide DAO rules implicitly.

## Ordered implementation checklist

- [ ] 1. Verify testnet integrations and all required data sources, including planned Intents routing and Bitte orchestration; record live versus fixture evidence. Evaluate SputnikDAO/Trezu, OutLayer and Agent Market separately without marking candidates integrated.
- [ ] 2. Implement backing, NEP-141 representation, redemption and burn with receipt replay protection and conservation.
- [ ] 3. Implement multi-community lifecycle, locked snapshots and actual creator/protocol deposits.
- [ ] 4. Integrate GoPlus and separate LP audit; keep unresolved required policy/data Pending.
- [ ] 5. Implement all four scoring modes and unlimited 30-second overtime.
- [ ] 6. Implement per-token settlement/revenue, deterministic rounding and confirmed Robinhood payouts with safe retries.
- [ ] 7. Isolate winning principal and obtain an explicit DAO design decision before disposition implementation.
- [ ] 8. Implement bounded NEAR AI player agents, MCP and terminal authorization/preview checks.
- [ ] 9. Complete UI, observability and end-to-end testnet demo with failure/recovery evidence.

## Progress against the checklist (2026-11-11)

The checkboxes above stay unticked on purpose: an item is ticked only when its acceptance gate is proven on testnet with recorded evidence. This section records where each item stands. "Code" means implemented and unit-tested with synthetic inputs; "proven" means recorded in [testnet-evidence.md](testnet-evidence.md). See [current-state.md](current-state.md) for the detail.

| # | Item | Code | Proven on testnet | Open |
| --- | --- | --- | --- | --- |
| 1 | Integrations and data sources | NEAR, Robinhood testnet RPC, GoPlus, DexScreener and mainnet pool reads wired | NEAR testnet and Robinhood custody transactions; GoPlus and pool reads in a dry run | NEAR Intents is a labeled fixture; Bitte orchestration not shown |
| 2 | Backing, representation, redemption, burn | Backing and receipt-registry contracts, custody verifier | Six backings deployed and wired | Six custody deposits are waiting for finality; no mint from a receipt, redemption or burn yet |
| 3 | Multi-community lifecycle | Arena lifecycle and the single lifecycle web app | Battle 1 created with six communities | Not locked; deposits are refused until audit and backing approvals exist |
| 4 | GoPlus and LP audit | Audit pass, policy, report archive, price pool reader | Dry run: five pass, AI pending (no liquidity evidence) | No approval submitted; AI cannot pass without a pool the reader supports |
| 5 | Scoring and overtime | Four modes and tie rounds in the arena, lifecycle oracle (dry run) | None | No round has run; the oracle account of the deployed arena is not confirmed set |
| 6 | Settlement, revenue, Robinhood payout | Settlement, payout relayer and operator, reconciler | None | Spendable custody (#148) and a confirmed payout are unproven; the terminal blocks payout |
| 7 | Principal isolation and DAO | Escrow and DAO entry points; DAO account on testnet | DAO proposals for wiring passed | The disposition decision is open |
| 8 | Player agents, MCP, terminal | Player policy, Agents page, player program (dry run), read API and MCP, lifecycle terminal | Policy redeployed on testnet | No live agent proposal sent; terminal model parsing needs a key the owner provides |
| 9 | UI, observability, full demo | Lifecycle UI, faucet page, live price preview | Pages checked in a browser against testnet reads | End-to-end demo with failure recovery (#80), connected deposit UX (#149) and portfolio and payout (#151) are open |

Also delivered outside the original checklist: the testnet faucet contract and page, token names and logos, and the display-only live price preview.

Dependency details and acceptance scenarios are in the roadmap. In particular, backing precedes deposits; audit gates live rounds; scoring precedes settlement; DAO disposition waits for governance design; UI cannot claim payment from a signature or broadcast alone.

The documentation PR must use **Refs #N**, not an auto-closing keyword. Keep this implementation issue open until its acceptance criteria are delivered.
