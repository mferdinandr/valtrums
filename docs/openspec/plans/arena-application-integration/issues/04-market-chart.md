## Outcome

Tracking: #146. Depends on #143 shared read boundary; qualified provider handoff is coordinated with #147. Supplies persisted evidence to #147 and optional charts to #149. Final cross-service acceptance: #80.

Connect the existing battle chart to durable attributable market evidence instead of synthetic demo history.

## Scope

Canonical change: `arena-market-observations`, all tasks. Inspect agent market-wiring/TWAP/DexScreener adapters and web battle-chart/snapshot/score-series components.

- Explicit chain/reference aliases and chain-aware normalization; no default-NEAR assumption for Robinhood assets.
- Durable append-before-publication journal, atomic manifest, replay/dedup/conflict/capacity handling. No database migration in initial scope.
- Full namespace/round/community/frozen policy mapping, exact inputs, nullable source time separate from acquisition time.
- Bounded observation routes extending the read API, cursors/revisions/gaps/watermarks and cancellable chart polling.
- Separate provisional rational scores from contract outcomes; retain legacy spot/TWAP labels and isolated fixtures. Never fabricate intermediate points or resolve from timer/chart/animation.

## Acceptance

- Restart/dedup/missing boundary/corruption/reorg/out-of-order response and exact score cases verified.
- Live modes gated individually by testnet-owner provider evidence. Rolling 24-hour volume/FDV cannot qualify exact interval volume/circulating cap. Price/drawdown are candidates for qualification, not automatically verified.
- Backend collection continues independently of visual pause; display refresh is not source cadence.

## Dependencies and delivery

Depends on shared read DTO/service. Oracle/provider runtime remains the testnet owner; publish a persisted-evidence reader handoff. Cross-service acceptance stays [#80](https://github.com/mferdinandr/valtrum/issues/80).

Local snapshot 2026-11-10: `feat/living-toy-world`, HEAD `4881fd76570a060659cafa7a4275e8740a5cdaf4` plus dirty tree. New OpenSpec artifacts/crosscheck are uncommitted; publish/reconcile before applying elsewhere. One focused branch/PR; no Playwright, deployment, funds or migrations authorized.
