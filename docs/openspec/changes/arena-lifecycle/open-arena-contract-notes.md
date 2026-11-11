# Open arena contract notes (phase P1)

Implementation notes for the contract part of the open arena. Product decisions live in `docs/findings-and-decisions.md`.

## ABI (INTERFACE v1, no renames)

- `create_lifecycle_battle(assets: Vec<AssetInput> /*0..=16*/, mode, start_at_ms: Option<U64>) -> u64` payable. The start time must satisfy now + 60 s <= start <= now + 7 days. The minimum of two communities now applies at lock.
- `set_lifecycle_joinable_asset(asset)` / `remove_lifecycle_joinable_asset(representation)`: protocol account only, exactly one yocto. Views `get_lifecycle_joinable_asset(representation) -> Option<AssetInput>` and `get_lifecycle_joinable_assets(from_index: U64, limit: U64)` (page capped at 50).
- `join_lifecycle_battle(battle_id: u64, representation: AccountId) -> u32` payable, storage measured and excess refunded. Idempotent for a caller who already has a position. Event `lifecycle_community_added` only for a new community.
- `lock_lifecycle_battle(battle_id, expected_communities: Option<u32>)`: still agent-only with at least 1 yocto.
- `cancel_lifecycle_battle(battle_id)`, `claim_lifecycle_refund(battle_id, community)` (one yocto), private callback `on_lifecycle_refund`.
- Views `get_lifecycle_start`, `is_lifecycle_cancelled`; `start_at_ms` and `cancelled` are added to the lifecycle view and so to the `_v1` view.
- Events: `lifecycle_community_added`, `lifecycle_battle_cancelled`, `lifecycle_refund` (emitted by the callback on success).

## Deviations and additions

- Extra events: `lifecycle_refund_failed` (callback rollback), `lifecycle_joinable_asset_set`, `lifecycle_joinable_asset_removed`.
- Allowlist views return `AssetInput` (chain id as string). The list is capped at 64 entries; its order is kept in a single vector under one key, because a collection built on demand has no persisted length.
- The allowlist storage is paid by the contract (one yocto call), like the reference registry.
- Joining, registering a position and depositing are refused from the start time on and after a cancel. A battle created without a start time keeps the old behavior and can never be cancelled or refunded.
- `cancel_lifecycle_battle` needs a start time; a battle without one is refused.
- Lock of a battle that is already locked stays idempotent and is not blocked by the start check.
- `hold_principal` now refuses a community with a zero vault.
- Readiness view still lists every community (the agent must audit and back unfunded communities so deposits can open).

## State layout

No field was added to `Arena`, `Battle`, `Community` or `Snapshot`. New state is in standalone maps with `StorageKey` variants appended at the end: `LifecycleStart`, `LifecycleJoinable`, `LifecycleJoinableIndex`, `LifecycleCancelled`. The integration test `previous_main_state_survives_a_redeploy_of_the_new_code` builds the arena wasm of commit `32a96ae`, creates a battle and a position with it, redeploys the new wasm over the same account and checks reads and new methods.

## Risks

- A funded community whose audit or backing expires or fails blocks the lock; with two or more funded communities nobody can cancel, so its deposits stay locked until the agent refreshes approvals (audit lives at most 24 h, backing 10 min).
- Positions registered but never funded leave small orphaned storage after a cancel.
- Anyone can cancel once the start time passes with fewer than two funded communities; the contract pays the tiny flag storage.
- Unit-test mocks keep writes of a panicking call; on chain they revert.

## Gas (sandbox, fixtures, total gas burnt)

- 16th join: about 4.3 TGas.
- Lock with 16 funded communities (open arena): about 6.8 TGas.
- First settlement batch of 15 entitlements over 15 losing communities (backings absent, so the batch fails after plan computation): about 35.5 TGas.
