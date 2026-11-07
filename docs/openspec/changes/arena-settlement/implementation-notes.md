# Settlement arithmetic

`contracts/arena/src/settlement.rs` is pure Rust. It reads no storage, authenticates no caller and moves no backing.

- `allocate_vault` takes one losing vault, the snapshotted `FeePolicy` and the final winner's participants with their deposits. Deposits of the same account are aggregated, input order is irrelevant, zero deposits are rejected and the weights must add up to the winning vault. The fee is `floor(vault * fee_bps / 10000)` in 256-bit arithmetic and the remainder is the winner pool. A user-created fee gives the creator `floor(fee * creator_share_bps / 10000)` and protocol the rest; a protocol-created fee goes wholly to protocol. The winner pool is shared by `floor(pool * deposit / winning_vault)`, then leftover units go to the largest fractional remainders, ties broken by ascending account-ID bytes. Fee or share above 10000 bps, an empty vault or inconsistent weights return an error and allocate nothing. The sum of all entitlements equals the vault.
- Zero amounts (for example a creator fee on a 1000-unit vault, or any fee on a 999-unit vault) produce no entitlement and do not affect the others.
- `allocate_battle` allocates every community except the recorded winner from the lifecycle's frozen snapshot, so communities eliminated in overtime settle as losing vaults too. `Battle` now exposes `community_count` and `principal_hold` for this. Each losing token is independent.
- `entitlement_id` is a SHA-256 over battle, losing community, recipient kind and account, so a retry reproduces identical identities and two tokens never share one.

## Contract entry point (`settle_api.rs`)

- Positions are now enumerable: `lifecycle_register_position` appends the account to a per-community participant index, and `lifecycle_participant_positions` returns credited deposits in registration order (zero deposits omitted). Deployments predating the index are not migrated, as with the rest of the lifecycle state.
- `settle_lifecycle_battle(battle_id, max_entitlements)` can be called by anyone once a unique winner is recorded. It recomputes the whole plan from the frozen snapshot, the recorded winner and the credited positions, so the caller cannot influence amounts or recipients. The plan has a fixed order (losing communities by index; within each, winners, creator, then protocol). The next batch of at most 15 entitlements is sent to the backing of each losing token (`allocate_entitlement`), with 0.01 NEAR forwarded per entitlement and the rest of the deposit refunded to the caller. The backing records each allocation id at most once, which burns the arena's locked representation of that token and creates the entitlement.
- `on_settle_batch` moves the per-battle cursor only if every call in the batch succeeded and the batch started at the cursor. A failed or partial batch changes nothing and is simply called again; repeats are harmless because the backing is idempotent per allocation id. Once the cursor reaches the end, further calls refund and return the total. `get_settlement_progress` reports recorded versus total.
- The winning community's vault is untouched: it stays minted and held by the arena, so rewards in the losing tokens do not wait for the open DAO decision.
- Tested with real arena (fixture build), two backings and the shared registry: 100000 units at 60/40 give alice 59940 plus her 50 creator fee, bob 39960 and protocol 50; the losing backing ends balanced with all 100000 units as entitlements and none minted; batches of 3 and 1 reach the same result; a second call changes nothing; too little deposit is refused before any call.

Not done, so the matching tasks stay open:

- Backing refunds of unused entitlement storage go to the arena contract (the caller of the backing), not back to the settler. Fees are `Protocol`/`Creator` entitlements like any other; nothing yet withdraws unused refunds.
- The plan is recomputed on every call (reads every winner position), so a very large winning community can exceed one call's gas; there is no stored plan. Rewards are limited by what the arena actually holds in each backing.
- Protocol-only fee configuration and its snapshot at battle creation (lifecycle work), and a combined view of entitlement and payout states, remain open.
- A lost response is covered by unit tests of the cursor callback and by idempotent repeats, not by a sandbox test that drops a real callback.
