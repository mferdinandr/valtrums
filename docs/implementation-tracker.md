# Implement the permissionless Robinhood arena for the NEAR hackathon

Publication status: **prepared locally; GitHub issue URL pending**. This is the exact parent issue content to publish after checking existing issues/PRs for duplicates.

## Product

Build a permissionless arena on NEAR testnet with original-token custody and payouts on Robinhood Chain testnet. Two or more communities compete in 30-second rounds; winners receive each losing token, and winning principal enters DAO escrow. This issue tracks implementation, not completion of the documentation proposal.

## Specifications

[Product](product-spec.md), [rules](battle-rules.md), [economics](token-economics.md), [architecture](architecture.md), [interfaces](interfaces.md), [ecosystem](ecosystem.md), [GoPlus policy](goplus-audit.md), [deployment](deployment.md), [security](security-review.md), [roadmap](implementation-roadmap.md), [current state](current-state.md), [OpenSpec](openspec/changes/redesign-permissionless-robinhood-arena/proposal.md).

When publishing to GitHub, expand these relative links to repository blob links on docs/near-hackathon-arena-spec so they resolve from the issue.

## Selected hackathon tracks

Memecoins With Mechanics, Games With Real Economies, Social Money and AI Swarms. Map evidence to each track; the AI Swarms demo uses multiple independently user-funded player agents, and Social Money preserves the OPEN governance design.

## Final decisions

- At least two communities; freeze communities/deposits before round 1; real positive creator participation including protocol creators; no bond.
- Creator selects Price % Gain, Market Cap % Growth, Volume-to-Market Cap Ratio or Lowest % Drawdown. Market cap is price × circulating supply; volume is round quote-volume / initial market cap; drawdown is maximum peak-to-trough decline.
- Every round is 30 seconds, no TWAP. Tied best candidates repeat with reset inputs without a cap. Deposits stay closed and every original vault stays locked.
- Each losing token: 99.9% proportional winning-player reward, 0.05% creator and 0.05% protocol; protocol-created battles pay the full 0.1% to protocol.
- Collect `floor(losing_vault / 1000)` first; split that fee 50:50 (odd unit to protocol), or all to protocol for a protocol creator. Largest remainder applies only to participant rewards.
- Payouts remain original losing tokens on Robinhood; distinguish allocated rights from confirmed transfer. Winning principal goes to DAO; rewards do not wait.
- NEP-141 backing is 1:1 actual received assets; exclusive reservations prevent redemption/payout/burn double use.
- GoPlus critical risk rejects, unknown mandatory data holds approval; LP separately must exceed USD 10,000.
- Player agents use bounded user funds/permissions. Infrastructure has no player spending authority.

## OPEN QUESTION

DAO membership, weights, quorum, deadline, execution/fallback; tax thresholds and token-admin policy; evidence freshness (field mapping is defined in [GoPlus policy](goplus-audit.md)); oracle providers/cadence/boundaries/supply; custody proof/finality/reorgs/gas/tax/burn; pre-lock cancellation and outage response; protocol identity and position rules. Preserve the [full question register](product-spec.md#open-question-register); do not decide DAO rules implicitly.

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

Dependency details and acceptance scenarios are in the roadmap. In particular, backing precedes deposits; audit gates live rounds; scoring precedes settlement; DAO disposition waits for governance design; UI cannot claim payment from a signature or broadcast alone.

The documentation PR must use **Refs #N**, not an auto-closing keyword. Keep this implementation issue open until its acceptance criteria are delivered.
