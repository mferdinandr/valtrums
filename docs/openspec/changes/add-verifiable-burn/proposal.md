# Proposal: Verifiable Burn and Burn Leaderboard

## Why

The 5% burn is the part of every battle that a meme community feels directly: its coin gets scarcer when it wins. Today that burn is a transfer to an ordinary account that the deployer controls (`burn.<owner>.testnet`), and the owner can change that destination at any time with `set_execution`. Nobody can verify that the coins are really gone. A failed burn leaves the coin in the arena with no way to retry it.

## What Changes

- **New furnace contract**, a keyless NEAR account that accepts any NEP-141 coin and has no method that sends coins out. It records how much of each coin was burned, and by which battle.
- **The arena burns only into the furnace.** The furnace account is fixed when the arena is initialised and has no setter. **BREAKING:** `set_execution` no longer takes a burn account.
- **Foreign-chain burns go to `0x000000000000000000000000000000000000dEaD`** only. That address is a constant, not owner configuration. **BREAKING:** `set_foreign` no longer takes a burn address.
- **The burn always registers the furnace with the coin first**, so a missing registration can no longer make the burn fail.
- **A failed burn stays pending and anyone can retry it.**
- **Burn leaderboard page.** Every coin that has fought in Valtrum, ranked by the share of its total supply that Valtrum battles burned, with the burn of each battle.
- No PRD rule changes: 5% of the proceeds still buys the winner coin and burns it. This change makes the burn real and visible.

## Capabilities

### New Capabilities
- `furnace`: the keyless sink: accepting coins, refusing to release them, and the burn ledger with its views and events.
- `burn-leaderboard`: the public page that ranks coins by the share of supply burned through Valtrum.

### Modified Capabilities
- `settlement-burn`: the destination becomes the fixed furnace, registration happens before the burn, failed burns can be retried, and the foreign-chain burn address is a constant.

## Impact

- **Contracts:**
  - new `contracts/furnace`
  - `contracts/arena`:
    - init takes the furnace id
    - burn step uses `ft_transfer_call` to the furnace after `storage_deposit`
    - `retry_burn`
    - `set_execution` and `set_foreign` lose their burn fields
- **Agent:** reads the constant EVM burn address instead of the configured one. No new calls.
- **Web:** new leaderboard page, plus a "burned" figure per battle.
- **Docs:**
  - security review: finding 7 and finding 17 (from mferdinandr/valtrum#33) are resolved
  - `docs/architecture.md`
  - `docs/deployment.md`
- **Deployment:** the furnace is launched keyless. The arena needs a fresh deployment because its init and settings change shape. That can be the same fresh deployment as War Bonds.
