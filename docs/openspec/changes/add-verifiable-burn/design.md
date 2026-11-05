# Design: Verifiable Burn and Burn Leaderboard

## Context

See proposal.md for why. Today the burn step buys the winner coin, books the step, and sends the coin with a plain `ft_transfer` to `ExecutionConfig.burn_account`, which the owner sets with `set_execution` (`contracts/arena/src/lib.rs`). On failure `on_burn_sent` emits `burn_failed` and the coin stays in the arena, untracked. Foreign-chain burns go to `ForeignConfig.burn`, which the owner sets with `set_foreign`.

## Goals / Non-Goals

**Goals:**
- A burn destination that nobody, including the owner, can spend from or redirect.
- A per-coin and per-battle burn record that a page can read without an indexer.
- No coin stuck in the arena after a failed burn.

**Non-Goals:**
- Lowering `ft_total_supply` of coins we do not control. NEP-141 has no standard burn call, so burned coins remain in the supply figure and sit in the furnace. The leaderboard reports the share held by the furnace.
- Counting coins sent to the furnace with plain transfers.

## Decisions

**1. A furnace contract instead of an account with no key.**
An account without keys and without code cannot receive `ft_transfer_call` (the call would fail and the coin would be refunded), and a plain transfer records nothing. A small contract that implements `ft_on_transfer`, keeps everything, and stores a ledger gives both a provable sink and a record. It is launched without keys, the same pattern as VALT in mferdinandr/valtrum#33.
- Alternative: a `system`-style or implicit account with no key. Rejected: no ledger, and NEP-141 contracts still need it registered.

**2. The furnace id is fixed in the arena's init.**
`set_execution` keeps only the DEX. The foreign burn address becomes a constant in `mpc.rs`, which already checks transfer recipients.
- Alternative: an owner setter that can be called once. Rejected: a setter still lets the owner choose a destination they control.

**3. Register, then burn, in one promise chain.**
The burn step calls `storage_deposit { account_id: furnace, registration_only: true }` on the coin with the coin's minimum storage deposit, then `ft_transfer_call` to the furnace with `{"battle_id": id}`, then `on_burn_sent`. NEP-145 refunds the deposit when the furnace is already registered. The arena pays this NEAR.

**4. Pending burns are a balance, not a step state.**
The settlement step stays done, because its amount was realized. A failed transfer adds the amount to `pending_burn[(battle_id, coin)]`. `retry_burn(battle_id)` zeroes the pending amount before sending and restores it in the callback on failure, so concurrent retries cannot double-send.

**5. Leaderboard share is burned divided by total supply.**
The furnace still holds burned coins, so `ft_total_supply` includes them and `burned / ft_total_supply` is the share of all coins that Valtrum took out of circulation.
- Alternative: `burned / (ft_total_supply + burned)`. Rejected: it would count the burned coins twice.

## Trust Assumptions

- **Furnace deployer**: none after launch; the account has no key.
- **Arena owner**: can no longer choose the burn destination. A malicious arena upgrade could skip burns of future battles, but it cannot recover coins already in the furnace.
- **Agent**: unchanged. It still triggers settlement steps, and it reads the constant EVM burn address.
- **Coin contracts**: a malicious coin can lie about balances or block transfers. The ledger records what the furnace was told it received.

## Risks / Trade-offs

- [The ledger counts what the transfer call reported, not balances] → The page also shows the furnace's `ft_balance_of` for each coin, which can only be equal or higher.
- [Storage for many coins and battles] → Entries are small, and only battles and transfer calls create them. Fund the furnace with NEAR at launch.
- [Arena pays registration NEAR per new coin] → About 0.00125 NEAR per coin, once.

## Migration Plan

1. Launch the furnace keyless and check `list-keys`.
2. Deploy the new arena with the furnace id, on the same fresh deployment as War Bonds if both ship together.
3. Coins already sent to `burn.<owner>.testnet` stay there. The docs list that amount as "burned before the furnace" so it is not presented as provably burned.

Rollback: point the agent and the web app back at the old arena. The furnace keeps what it received.
