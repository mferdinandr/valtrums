# Settlement arithmetic

`contracts/arena/src/settlement.rs` is pure Rust. It reads no storage, authenticates no caller and moves no backing.

- `allocate_vault` takes one losing vault, the snapshotted `FeePolicy` and the final winner's participants with their deposits. Deposits of the same account are aggregated, input order is irrelevant, zero deposits are rejected and the weights must add up to the winning vault. The fee is `floor(vault * fee_bps / 10000)` in 256-bit arithmetic and the remainder is the winner pool. A user-created fee gives the creator `floor(fee * creator_share_bps / 10000)` and protocol the rest; a protocol-created fee goes wholly to protocol. The winner pool is shared by `floor(pool * deposit / winning_vault)`, then leftover units go to the largest fractional remainders, ties broken by ascending account-ID bytes. Fee or share above 10000 bps, an empty vault or inconsistent weights return an error and allocate nothing. The sum of all entitlements equals the vault.
- Zero amounts (for example a creator fee on a 1000-unit vault, or any fee on a 999-unit vault) produce no entitlement and do not affect the others.
- `allocate_battle` allocates every community except the recorded winner from the lifecycle's frozen snapshot, so communities eliminated in overtime settle as losing vaults too. `Battle` now exposes `community_count` and `principal_hold` for this. Each losing token is independent.
- `entitlement_id` is a SHA-256 over battle, losing community, recipient kind and account, so a retry reproduces identical identities and two tokens never share one.

Not done, so the matching tasks stay open:

- Nothing persists allocations or calls the backing's `allocate_entitlement`; an entry point in the arena must authenticate the trigger, store the allocation IDs and make the call. `Entitlement` carries no asset field yet, so asset binding is by the losing community and its snapshot.
- The winners list is supplied by the caller from position records; there is no pagination, so determinism across pages is not exercised.
- Protocol-only fee configuration, snapshotting it at battle creation and the entitlement states exposed to payout are lifecycle and payout work, not covered here.
