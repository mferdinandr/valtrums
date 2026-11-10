## Outcome

Tracking: #149. Depends on #143; live release handoffs: #144, #145, #147 and #148. #146 chart delivery is optional to core lifecycle UI, not a financial authority. Final acceptance: #80.

Integrate multi-community lifecycle create/deposit/detail UX with the existing 3D arena, matching confirmed contract state rather than legacy A/B assumptions.

## Scope

Canonical change: `arena-lifecycle-frontend`, all tasks. Inspect web providers/Create/Detail/deposit components and colosseum runtime; reuse current wallet review/sender conventions.

- Explicit lifecycle adapter, backend-searched 2+ community assets, trusted identity and actual wire modes.
- Correct creation storage, separate position storage, representation FT registration/claim and `lifecycle_deposit` transfer-call intent. No legacy USDC bond/duration/economics.
- Receipt/source-transfer pending UX and confirmed backing/position credit; no verifier/operator keys in browser.
- Extend read gateway with current-round/history enrichment; current contract limitations remain unknown/unavailable until owner handoffs land.
- Drive scene candidates/window/overtime/winner from authoritative records. Timer expiry, chart leaders and 3D attacks remain cosmetic.
- Preserve existing mascot registry/generic fallback, reduced-motion/WebGL failure controls, responsive readability and retry identity.

## Acceptance

Verify two/three-community flows, exact calls/storage-versus-stake, rejected wallet, source transfer without credit, pending round and fallback states. No fixture can satisfy live evidence. Source-transfer actions remain disabled until compatible activation, audit/backing/verifier and **spendable custody-to-payout** are verified; current deposit-only custody is insufficient.

## Dependencies and delivery

Depends on read API; financial release depends on contract/indexer, audit, custody and oracle handoffs. Charts can develop independently. MCP/player grants and DAO release remain outside scope. Cross-service acceptance: [#80](https://github.com/mferdinandr/valtrum/issues/80).

Snapshot: local `feat/living-toy-world`, HEAD `4881fd76570a060659cafa7a4275e8740a5cdaf4` plus dirty tree, 2026-11-10. Split OpenSpec artifacts/crosscheck and existing 3D changes are not all published: reconcile/publish before apply in another checkout. No Playwright, migrations, deployment or funding authorized.
