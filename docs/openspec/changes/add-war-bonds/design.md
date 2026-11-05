# Design: War Bonds

## Context

See proposal.md for why. Today the arena keeps credit as `credit_balance` and `credit_expires_at_ns` per account (`contracts/arena/src/credit.rs`). The credit pool's USDC stays in the arena after a settlement, and nothing books it once credit expires. The arena has an owner with keys, so a coin whose rules must be immutable cannot live inside the arena account.

## Goals / Non-Goals

**Goals:**
- A WAR coin whose rules nobody can change after launch, including the deployer.
- Value that melts on a fixed schedule and cannot be dodged by moving coins.
- Every melted USDC accounted for and paid back to future winners.

**Non-Goals:**
- WAR trading on AMMs. A coin whose balance falls without a transfer breaks AMM pool accounting; WAR is meant to be held, gifted or sold over the counter.
- Changes to the 55/35/5/5 split itself or to how winners are chosen.

## Decisions

**1. WAR is its own keyless contract that holds the backing.**
Launch it like VALT in mferdinandr/valtrum#33: deploy, initialise and delete the only key in one batch. The WAR contract holds all USDC that backs WAR, so the arena owner cannot spend it.
- Alternative: implement NEP-141 inside the arena. Rejected: the arena account has keys and owner setters, so its rules would not be immutable.

**2. Lazy per-account melt.**
Each account stores its value and the step (hour) it was last updated. Reading or touching a balance applies the melt for the steps since then as one exact power of `1 - 4380/1_000_000`, rounded down. The total supply is tracked the same way and is never lower than the sum of balances, so the backing check stays safe.
- Alternative: a global rebasing index (shares times an index that shrinks daily). Simpler, but the index heads to zero over time and new mints would need ever larger share counts. Rejected for overflow risk.
- Alternative: a 7-day timer per account (today's rule). Rejected: sending coins to a fresh account would restart the timer.

**2a. Hourly steps of 4380 ppm instead of one daily step of 10%.**
A daily step would take a full 10% from anyone who received WAR just before the day boundary. 24 hourly steps of `1 - 0.9^(1/24)` give the same daily effect without that cliff. The exact hourly share is 0.43804%. Rounded to whole parts per million, 4380 ppm gives 9.9991% per day and 4381 ppm gives 10.0013%. 4380 is chosen so that a day never costs more than 10%. Basis points are too coarse: 44 bps per hour would be 10.04% per day.
- Alternative: a continuous melt per second. Rejected: no visible benefit over hourly steps, and the power has to be computed over far larger exponents.

**3. Mint path: the arena pays USDC into WAR.**
At `claim`, the arena sends the credit share in USDC to WAR with an `ft_transfer_call` whose message names the winner. WAR checks that the sender is the arena and the token is USDC, registers the winner if needed, and mints. If the mint fails, the arena keeps the USDC as a pending mint for that winner, and anyone can retry it. The share never turns into liquid USDC.

**4. Redemption path: WAR in, USDC out, deposit continues.**
A holder sends WAR to the arena with a deposit message (battle, side, optional top-up from the internal USDC balance, minimum coin out). The arena calls WAR's `redeem` for the WAR it just received. WAR burns it and sends the same amount of USDC to the arena, and the arena continues with the existing USDC deposit route through the router. On failure the arena sends the USDC back into WAR to re-mint for the depositor, and restores the internal balance.

**5. Melt release is permissionless and has one destination.**
`release_melt` sends the backing minus the total supply to the arena with a `prize_reserve` message. The arena accepts that message only from the WAR account. The WAR and arena account ids are fixed in each other's init; account names are chosen before deployment, so there is no cycle.

**6. Bonus locked at approval, paid at settlement.**
`approve_battle` moves `bonus = floor(reserve * draw_bps / 10000)` from the reserve into the battle, and the battle view shows it for the whole deposit window. When the dump is booked, the bonus is added to the realized amount before `split_profit`. Buy, burn and fee steps already spend USDC held by the arena. A void for an empty side or a tie, or a halt, sends the bonus back to the reserve.
- Alternative: draw when the dump is booked. Rejected: players would not see the bonus while deciding whether to deposit.
- Alternative: lock it when the battle goes Live. Rejected: the bonus would appear only after deposits close.
- Trade-off: battles approved right after a large release get a larger bonus, and the share shrinks for each battle approved after it. That is intended: the reserve spreads over the next battles instead of going to one.

**6a. The agent releases the melt right before approving.**
Locking the bonus from a stale reserve would hand melted value to later battles instead of this one. The agent already sends `approve_battle`, so it sends `release_melt` to WAR first, waits for it to finish, and approves either way. "Nothing has melted yet" and other release failures are logged and ignored.
- Alternative: the arena pulls the release itself inside `approve_battle`. Rejected: the bonus would then be locked in a callback, after the release resolves, which splits approval over two receipts for no gain. `release_melt` stays permissionless, so anyone can still call it at any time.

**7. Fresh deployment.**
Arena state changes shape (credit fields removed, reserve added, WAR id added). Testnet moves to new accounts instead of migrating state.

## Trust Assumptions

- **WAR deployer**: none after launch; the account has no key.
- **Arena owner**: can still upgrade the arena. A malicious upgrade could take the prize reserve and any WAR or USDC in flight inside the arena. It cannot touch WAR that holders keep or the backing held by WAR.
- **Agent**: no role in WAR. It still approves and settles battles, so a bonus is locked only when the agent approves and paid only when it settles. If it stops, locked bonuses wait in their battles until settlement, void or halt.
- **USDC contract**: the backing is only as good as the USDC token. On testnet that is the open-mint mock USDC, so backing there proves the mechanics, not value.
- **Sybil resistance**: WAR is minted only from real battle profit, so splitting accounts earns nothing extra.

## Risks / Trade-offs

- [In-flight transfer calls cross a step boundary] → The resolve step converts the unused amount back to current value before refunding, so a refund never restores melt.
- [Wallets show a balance that falls without transfers] → The token page and docs explain the melt; `get_account` shows the next loss and when it happens.
- [WAR pays registration storage for winners] → Registration happens only on mint, which needs a real win. Fund WAR's NEAR at launch and monitor it.
- [10% per day is gentle: 48% of the value is left after a week, so the push to fight again is softer than the old 7-day cliff] → Chosen on purpose, so a winner who waits a few days is not punished hard. The prize reserve fills more slowly as a result; the simulation shows by how much.

## Migration Plan

1. Deploy WAR, a new arena and a new router to fresh testnet accounts. The WAR and arena ids reference each other at init.
2. Delete WAR's key in the launch transaction, then confirm with `list-keys`.
3. Point the agent and the web app at the new arena.
4. The old arena keeps running for its outstanding credit until that expires. No funds move between deployments.

Rollback: point the agent and the web app back at the old arena. WAR on the new deployment keeps its backing; nothing is lost.

## Open Questions

- `draw_bps`, to be taken from the simulation. The melt is decided: 4380 parts per million per hourly step, 10% per day.
