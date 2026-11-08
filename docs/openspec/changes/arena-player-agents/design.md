## Context

One independently reviewed change in the arena redesign. See [coordination](../../README.md) and [product specification](../../../product-spec.md).

## Goals / Non-Goals

Deliver bounded player agents and its acceptance scenarios without claiming unrelated work or unverified network support.

## Decisions

- Contract: [capability requirements](specs/arena-player-agents/spec.md).
- Integration boundary: Coordinate player identity and deposit interface with lifecycle and backing.
- Asset identity binds source chain/token, NEAR representation and custody domain.
- Keep custody verifier, oracle, signer, operator and player authorization boundaries explicit. Fixtures do not prove live execution. DAO governance and provider/finality choices remain OPEN.
- Bounded player grants and atomic budget reservations (`contracts/player-policy`, crate `valtrum-player-policy`). Pure policy core plus a persistent NEAR wrapper, isolated from backing/payout/arena. A reservation is an authorization and a budget hold, never a token transfer, proof of funds, custody reservation or confirmed payment; no signing, MPC call or custody access happens here.
  - API (wrapper). `create_grant(input)` — caller is the grant user; creates a grant or a strictly higher version, preserving old versions and the shared budget counters. `revoke_grant(local_id)` — user-only, one-yocto, persistent, idempotent. `reserve(action)` — delegate-or-user only; validates the canonical action against the grant and reserves budget in one transition; idempotent per request identity. Views `get_grant`, `get_budget`, `get_reservation`; events `grant_created`, `grant_revoked`, `budget_reserved` under standard `valtrum_player_policy` v1.
  - Identity and units. `GrantId = sha256(user, local_id)` (version excluded). `request_key = sha256(user, local_id, request_id)` is the idempotency identity (version excluded, so a changed action under the same request is a conflict). `action_hash` binds user, grant version, delegate, exact asset, target, method, destination, amount, gas, request id and battle/community. Token amounts and the authorized/cumulative caps are `U128` atomic units with checked arithmetic; heights/timestamps are `U64`; the gas bound is a declared per-action `U64` unit, explicitly not measured foreign-chain gas. Assets are canonicalized (lowercased 20-byte address) and never identified by ticker.
  - Caller matrix. create_grant: user (caller) only — a delegate/stranger can only create grants where they are the user, never widen another user's. revoke_grant: user only (identity-derived). reserve: delegate or user only — auditor/scheduler/relayer/operator/owner are denied. Outcome transitions: a configured executor only, and only in the fixture build. The owner has no path to originate a grant, widen a limit, consume funds or release an obligation.
  - Budget and transition table. Invariant `consumed + reserved <= authorized_limit`; `available = limit - consumed - reserved`. A replacement cannot change the grant's asset identity or lower its cap below consumed plus reserved units; rejected replacements leave the existing version/history/budget untouched. Use a new local grant ID for another asset. Reservation states: `Reserved → Dispatched` (first admission rechecks current version, expiry and revocation), `Reserved → Released` (safe cancel before dispatch), `Dispatched → Consumed` (confirmed execution, consume exactly once), `Dispatched → ReconciliationRequired` (timeout/missing callback — reservation retained), `ReconciliationRequired → Consumed|Released` (explicit bound evidence). A dispatched obligation can never be released by timeout, restart or revocation alone; conflicting terminal outcomes fail closed. Replacing/revoking/expiring a grant blocks admission of its old queued reservations but does not prevent reconciliation of already-dispatched obligations.
  - External-evidence boundary. Outcome transitions live in the pure core and are exposed only by the `sandbox-fixtures` build via executor-guarded `fixture_*` methods; the normal (deployed) build compiles none of them, so there is no fabricated confirmation or unlock bypass (`FIXTURES_ENABLED == false`; a sandbox test asserts the methods are absent). A future reviewed executor/MCP adapter must reconstruct and enforce the exact `action_hash`, admit it once (dispatch), and resolve it via consume or evidence-bound reconciliation; this issue implements no bridge, receipt verifier or live operator authority.
  - Scoped security review. Authentication is the NEAR caller, never a JSON field; infrastructure roles gain no spending authority; grants and budgets persist in contract state so a client restart cannot reset them; a version bump cannot reset obligations or evade the cap; storage growth is charged; NEAR state is public, so no keys, credentials, prompts or unnecessary personal data are stored. Limitation: this enforces budget authorization only — it does not prove custody, real spending enforcement, or that any downstream execution path consumes the authorization; that binding is the deferred executor's obligation.
  - Deferred (open): signed/MPC execution and evidence adapter, binding accepted deposits/positions to the user, and MCP/terminal status and revocation integration.

## PR review corrections (2026-11-08)

- Keep chain, token, representation, custody domain and mapping version immutable across versions of one grant ID. The shared budget therefore always measures one asset's atomic units.
- `Budget::relimit` returns an error before mutation if the new limit is below checked `consumed + reserved`; the wrapper validates before writing history or the new version. Exact-use limits remain valid.
- The fixture execution-admission boundary requires the queued reservation's version to equal the current grant version. Regranting after expiry or revocation cannot revive an old queued action; prior dispatched obligations remain resolvable through their original reservation.
- All policy events use NEP-297 `data: [record]`, matching the arena emitter. Canonical grant/action input records reject unknown fields, including nested asset/battle fields, rather than silently discarding uncommitted data.
- Regression coverage includes on-chain replacement rollback, each immutable asset field, cap boundaries, unknown JSON fields, event array shape, expired/revoked version replacement and reconciliation after a grant replacement. These are fixture/policy tests, not evidence of live spending enforcement.

## Risks / Migration

Cross-chain operations must be idempotent, reconciled before retry and fail closed on missing evidence. Use isolated testnet deployments; legacy migration is out of scope.
