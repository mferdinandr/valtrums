# Implementation roadmap

> **Note (2026-11-14):** The Robinhood Chain testnet custody, the EVM contracts and payouts to Robinhood are retired. Valtrums now runs on NEAR only; Robinhood Chain mainnet is only read for prices and token audits. Steps below about custody, payouts or Chain Signatures are historical. See [current state](current-state.md).

Status: **proposal; implementation tasks are unfinished**. The documentation PR changes no application code or deployment.

Canonical requirements: [product](product-spec.md), [battle rules](battle-rules.md), [economics](token-economics.md), [architecture](architecture.md), [interfaces](interfaces.md), [security](security-review.md), [ecosystem](ecosystem.md). [OpenSpec change map](openspec/README.md) and [shared design](openspec/arena-design.md) specify the target.

Implementation tracker: [publish-ready parent issue](implementation-tracker.md). GitHub issue URL is pending verified publication; do not infer that it exists from this document.

| Order | Work | Depends on | Acceptance gate |
| --- | --- | --- | --- |
| 1 | Testnet integration and data sources | None | Actual chain/signer/GoPlus/market-data evidence plus planned Intents routing and Bitte orchestration; unsupported paths labeled; frozen observation policy feasible |
| 2 | Backing, NEP-141, redemption and burn | 1, custody/finality design | Actual-received mint; replay prevention; exact normalization; exclusive liabilities and recovery |
| 3 | Multi-community lifecycle and creator deposit | 2 | Two/three nonempty communities; real creator/protocol stake; no bond; immutable snapshot; late deposits recoverable |
| 4 | GoPlus and independent LP audit | 1; gates approval in 3 | Critical risk rejects, unknown holds Pending, LP strictly > USD 10,000; audit policy v1 (decided 2026-11-07) applied before live approval |
| 5 | Four scores and overtime | 3, 4, observation policy | Exact signed/rational math, 30-second rounds, no TWAP; repeated ties reset leaders only, all vaults locked |
| 6 | Per-token settlement, revenue and Robinhood payout | 2, 5 | Configurable snapshotted fee and creator share; deterministic rounding; final native receipts and idempotent retries |
| 7 | Principal escrow and DAO design | 2, 6 for allocation; governance decided (D22) | Principal isolated; losing-token payouts independent; winner vote per [DAO governance](dao-governance.md), no fallback beyond it |
| 8 | NEAR AI player agents and MCP | 3–6, enforceable authorization | Bounded budget, destinations, expiry/revocation; preview integrity; infrastructure cannot spend user funds |
| 9 | UI, observability and full demo | 1–8 | Separate entitlement/transfer/DAO status, event replay, alerts; recorded two/three-community and failure demos |

DAO design discussion may begin earlier; a live principal-disposition implementation waits for the explicit decision. Infrastructure/data adapters can be developed with fixtures, but fixture tests cannot satisfy live service gates.

## Required scenario matrix

- Two/three communities, user/protocol creators, creator on winning/losing community.
- Negative gain/growth, supply moving against price, initial-cap volume ratio, zero drawdown and interim-peak drawdown.
- Repeated ties, fresh round scores, eliminated vaults locked and deposits closed.
- Exact USD 10,000 liquidity, unknown mandatory audit fields, unsupported chain and stale data.
- Uneven/tiny token amounts, all fee recipients, decimal normalization and per-token conservation.
- Replay/reorg deposit, concurrent redemption/disposal/payout, failed callback and lost broadcast response without double payment.
- Unresolved DAO with rewards payable, malicious prompt/credential, spent/revoked/expired player grant and service-role denial.

## Delivery policy

Implement in dependency-sized PRs with evidence. Reuse legacy code only after reviewing its assumptions against the target. Earlier Ref swap settlement, TWAP, bonds, credit and WAR/furnace integration proposals are historical context, not target acceptance criteria. Do not archive this proposal or check implementation tasks merely because the documentation merged.
