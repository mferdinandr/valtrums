# GitHub integration issues

Created 2026-11-10 in `mferdinandr/valtrum`. The sibling body files are the published
scope/acceptance snapshots, including disclosure that new planning artifacts are
local/uncommitted. Publish/reconcile the docs before applying new change names in
another checkout. Each issue references its canonical OpenSpec owner; this index
is not an additional implementation checklist.

| Issue | Scope | Dependencies / release gates |
| --- | --- | --- |
| [#143](https://github.com/mferdinandr/valtrum/issues/143) | [Read API](01-read-api.md) | Start schemas/recorded tests now; live handoff #144/#145 |
| [#144](https://github.com/mferdinandr/valtrum/issues/144) | [Views and live indexer](02-views-indexer.md) | Coordinate shared DTOs; contract then reducer rollout |
| [#145](https://github.com/mferdinandr/valtrum/issues/145) | [Audit archive producer](03-audit-archive.md) | Independent producer handoff to #143/#149 |
| [#146](https://github.com/mferdinandr/valtrum/issues/146) | [Durable observations and charts](04-market-chart.md) | #143 boundary; qualified provider handoff with #147 |
| [#147](https://github.com/mferdinandr/valtrum/issues/147) | [Oracle scheduler/runtime](05-oracle-runtime.md) | #146 persisted reader; #144 ABI; provider qualification |
| [#148](https://github.com/mferdinandr/valtrum/issues/148) | [Custody compatibility and verifier](06-custody-verifier.md) | Reviewed spendable source path; financial gate, not a reason to block recorded/read-only work |
| [#149](https://github.com/mferdinandr/valtrum/issues/149) | [Lifecycle frontend and 3D adapter](07-lifecycle-frontend.md) | #143; live handoffs #144/#145/#147/#148; #146 optional chart |
| [#150](https://github.com/mferdinandr/valtrum/issues/150) | [Signing and confirmation runtimes](08-payout-runtime.md) | #148 for live custody; #144 for projection handoff |
| [#151](https://github.com/mferdinandr/valtrum/issues/151) | [Portfolio and payout frontend](09-portfolio.md) | #143/#144 account reads; #148/#150 for live requests |

Existing [#80](https://github.com/mferdinandr/valtrum/issues/80) remains the final
cross-service acceptance owner, including broader MCP/player/Intents/DAO gates.
No duplicate acceptance issue was created, and no historical closed issue was
reopened or treated as proof of completion.
