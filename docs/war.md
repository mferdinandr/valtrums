# WAR, the war bonds

> Historical/legacy design: this page is not the Robinhood target. The [product specification](product-spec.md) supersedes earlier swap settlement, TWAP, bond and credit plans. Standalone WAR and furnace source exists at the [base snapshot](current-state.md); arena integration/deployment is not implied.
WAR (`contracts/war`) is an NEP-141 coin that carries a winner's locked profit share, the 35% of the 55/35/5/5 rule. It replaces the arena's internal credit. The spec is `docs/openspec/changes/add-war-bonds`.

## The rules

| Rule | Value at launch | Where to read it |
| --- | --- | --- |
| Melt per step | 4380 ppm (0.4380%) | `get_params().melt_ppm` |
| Step length | 3600 seconds | `get_params().step_secs` |
| Effect per day | 9.9991% (never more than 10%) | 24 steps of 4380 ppm |
| Backing | 1 USDC per WAR minted | `get_state().backing` |
| Who mints | the arena only, by paying USDC in | `get_params().arena` |
| Who redeems | the arena only, for WAR it holds | `get_params().arena` |
| Where melted USDC goes | the arena's prize reserve | `release_melt` |

`new` fixes all of them. There is no owner and no setter, and the account is launched without keys, so the rules and the code cannot change.

## How the melt works

At every step boundary counted from launch, every balance loses 4380 parts per million of its value. 100 WAR becomes:

| After | Balance |
| --- | --- |
| 1 hour | 99.562000 |
| 1 day | 90.000866 |
| 2 days | 81.001559 |
| 7 days | 47.832913 |
| 14 days | about 22.9 |

- **Balances update lazily.** Each account keeps its value and the step it was last touched, and a read applies the melt for all steps since then as one exact power, rounded down. Nothing needs to run every hour.
- **Moving coins does not help.** The melt depends only on time since launch, not on when an account last acted. Sending WAR to another account, or around in a circle, keeps exactly the same melt.
- **No cliff.** Because the melt is hourly, receiving WAR one minute before a full hour costs 0.438 WAR per 100, not a whole day's melt.
- **Total supply.** The supply melts the same way but rounds up by at most 2 units, so it is never below the sum of balances. The backing is always at least the supply, and the difference is the melted backing.

## Flows

- **Mint (arena):** the arena sends USDC to WAR with `ft_transfer_call` and the message `{"action":"mint","receiver_id":"<winner>"}`. WAR checks that the token is USDC and the sender is the arena, registers the winner if needed (paid from WAR's own NEAR), and mints the same amount. Anything else is refunded.
- **Redeem (arena):** `redeem(amount)` burns WAR that the arena holds and pays the same USDC to the arena. If the USDC payment fails, the WAR is put back and the call resolves to `false`.
- **Release the melt (anyone):** `release_melt()` sends the backing above the supply to the arena with the message `{"action":"prize_reserve"}`. Whatever the arena refuses becomes backing again.
- **Transfer calls:** what a receiver hands back is melted to the current step before the refund, so a refund never restores melt.

## Views and events

- **Views:**
  - `get_params`
  - `get_state`: step, next boundary, supply, backing, melted backing
  - `get_account`: balance, next loss, next boundary
  - plus the NEP-141, NEP-145 and NEP-148 views
- **Events:**
  - standard `ft_mint`, `ft_burn` and `ft_transfer`, with memos `war bond`, `redeem`, `redeem refunded`, `refund`, `forced unregister`
  - `melt_released` under the `war` standard

## Trust and limits

- **The deployer** has no power after launch.
- **The arena owner** can still upgrade the arena. A malicious arena could take the prize reserve and any WAR or USDC that is in flight inside the arena. It cannot touch WAR that holders keep, or the backing held by WAR.
- **No sybil check is needed.** WAR is only minted from real battle profit, so splitting accounts earns nothing.
- **Wallets and AMMs.** Balances fall without transfers. Wallets show the current value. WAR is not meant for AMM pools, whose accounting assumes balances only change through transfers.
- **Testnet backing.** On testnet the backing is the open-mint mock USDC, so it demonstrates the mechanics, not value.
- **Storage.** WAR pays storage for winners it registers on mint. Accounts that registered themselves get their deposit back on unregister. Accounts WAR registered do not.
