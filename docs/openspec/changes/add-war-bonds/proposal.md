# Proposal: War Bonds

## Why

The 35% locked credit is Valtrum's retention loop, but today it is only a number inside the arena. Nobody can see it, hold it or pass it on, and when it expires its USDC stays in the arena without being booked anywhere. Turning it into a coin that visibly melts every day gives winners a reason to fight again soon. Sending the melted value to future prize pools makes waiting pay the people who keep fighting.

## What Changes

- **New coin `WAR` (NEP-141, 6 decimals).** Winners receive their 35% profit share as WAR instead of internal credit. At mint, 1 WAR is backed by 1 USDC held by the WAR contract.
- **Melt of 10% per day, applied hourly.** Every WAR balance loses 0.4380% of its value each hour, which is 10% per day (48% is left after 7 days, 23% after 14). Hourly steps mean that receiving WAR just before midnight costs one hour of melt, not a whole day. The rate is fixed at launch, readable by anyone, and has no admin key.
- **Battle-only redemption.** WAR can be transferred freely, but only the arena can turn it back into USDC, and only to fund a battle deposit. Holders cannot cash out directly.
- **Melted value feeds the prize reserve.** The USDC backing that melted away is released to the arena's prize reserve. Each battle locks a fixed share of the reserve as its **bonus when it is approved**, so the bonus is shown during the deposit window and draws players in. The bonus joins the profit when the battle settles and goes back to the reserve if the battle ends without a winner.
- **BREAKING (product rule):** the PRD rule "credit expires after 7 days, a new grant restarts the timer" becomes "WAR melts 10% per day, in hourly steps". Internal credit balances, `deposit_with_credit`, and the credit fields of the account view are removed.
- **Hybrid deposits stay possible.** A WAR transfer can be combined with the sender's internal USDC balance in one deposit (PRD example: 35 from WAR + 15 from the wallet).

## Capabilities

### New Capabilities
- `war-bonds`: the WAR coin itself: minting by the arena, the daily melt, transfers, battle-only redemption, the melted backing, and its public views and events.
- `prize-reserve`: the arena's pool of melted WAR backing, the bonus each battle locks at approval, and how that bonus joins the profit or returns.

### Modified Capabilities
- `battle-credit`: credit is paid as WAR instead of an internal balance. Expiry by timer is replaced by the melt. Credit-first funding uses WAR.

## Impact

- **Contracts:**
  - new `contracts/war` (keyless account, no owner)
  - `contracts/arena`:
    - claim mints WAR
    - deposit paths accept WAR
    - new prize reserve
    - credit state removed
  - `contracts/router` unchanged
- **Agent:** calls `release_melt` on WAR before each `approve_battle`, so the bonus comes from an up-to-date reserve. A release with nothing melted is ignored. Approval itself locks the bonus in the arena, and settlement adds it to the profit.
- **Web and terminal:** show WAR balance and melt instead of credit and expiry. The intent source "credit" means WAR.
- **Docs:**
  - PRD section 4 (decaying loop)
  - `docs/architecture.md`
  - README: WAR rules, and why sybil resistance is not needed for minting
- **Migration:** testnet only. The current testnet arena still holds credit from the demo battles (14 and 13.94 USDC, see `docs/deployment.md`). The new contracts go to a fresh deployment and that credit stays on the old one (see design.md).
