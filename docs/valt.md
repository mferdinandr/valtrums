# VALT, the war-drum coin

VALT is an NEP-141 memecoin whose mechanic is in the token contract itself (`contracts/valt`). There is no backend: if every server of this project went down, the ritual would keep working for anyone who can sign a transaction.

## The ritual

Every day, each holder may **muster** (check in) once.

- If the day ends with at least `muster_target` musters, the community **streak** grows by one and every musterer of that day is granted `mint_per_muster` newly minted VALT.
- If the day ends short of the target, `burn_bps` of the **war chest** burns and the streak resets to zero. A day with no musters at all is missed too, so going quiet costs the chest a slice per day.
- The **longest streak** is kept as the high score, with the day it ended.

The war chest is the VALT held by the contract's own account. It is filled at launch, and anyone can feed it with a plain `ft_transfer` to the contract. A bigger chest makes every missed day hurt more.

Supply therefore reacts to the community: active days add coins, quiet days remove them. It can never grow past `max_supply`. When the cap is near, the remaining headroom is shared equally by the day's musterers.

## Rules

All rules are fixed by `new` and can be read with `get_params`. The contract has no owner and no method that changes them, and the launch script deletes the contract account's only key, so the code cannot be replaced either.

| Rule | Meaning | Bounds enforced by `new` |
| --- | --- | --- |
| `day_length_secs` | length of a day, counted from launch | 60 seconds to 30 days |
| `muster_target` | musters needed for a day to count | at least 1 |
| `mint_per_muster` | new VALT for each musterer of a good day | at least 1 |
| `burn_bps` | share of the war chest burned on a missed day | 100 to 5000 (1% to 50%) |
| `min_balance` | balance needed to muster, kept until the day ends | at least 1 |
| `war_chest` | VALT held by the contract at launch | at least 1 |
| `max_supply` | supply cap, launch supply included | at least the launch supply |
| `allocations` | up to 50 accounts that receive VALT at launch | no duplicates, not the contract |

The values for the testnet launch are picked from the 60-day simulation (added in its own change). Until then `scripts/launch-valt-testnet.sh` uses provisional defaults that can be overridden with environment variables.

## How days close

Days close lazily. The first `muster`, `claim_reward` or `close_days` after a day ends closes it, and closes any idle days since then as one log entry. Anyone may call `close_days`. The views project days that ended but are not closed yet, so the page never shows stale numbers.

A run of idle days applies the burn once per day to what is left (10% over three days burns 1 - 0.9³ = 27.1%). The loop stops as soon as a slice rounds down to zero, so closing a long gap stays cheap.

Rewards are minted when claimed. A holder's next `muster` claims the reward for their previous one, and `claim_reward(account_id)` claims it without mustering. Until then the reward counts as `unclaimed_rewards`, which also counts against `max_supply`.

## Methods

| Method | Who | What |
| --- | --- | --- |
| `muster()` | any holder with `min_balance` | check in for today, claiming the previous reward |
| `claim_reward(account_id)` | anyone | mint `account_id`'s reward for a closed day that met the target |
| `close_days()` | anyone | close every ended day |
| `burn(amount)` | any holder, 1 yoctoNEAR | burn the caller's own coins |
| NEP-141 and NEP-145 | as the standards say | transfers, storage registration |
| `get_params`, `get_state`, `get_log`, `get_pending_log`, `get_account` | views | everything the token page shows |

Every mint and burn emits the standard NEP-297 `ft_mint` or `ft_burn` event with a memo (`war chest`, `launch allocation`, `muster reward`, `missed muster`, `holder burn`, `forced unregister`). Every closed day emits a `valt` `day_closed` event, and every check-in emits `muster`. `get_log` returns the closed days from contract state, so the page needs no indexer.

## Sybil resistance and its limits

The check is capital-based, and it is meant to be good enough for a demo, not more.

What it does:

- An account needs `min_balance` to muster, and an account that mustered cannot move its balance below `min_balance` until the day ends. Transfers, transfer calls and burns are all checked. So the same coins cannot muster twice in one day by hopping between accounts, and N musters in a day need N × `min_balance` VALT.
- An account must register with the token (a NEAR storage deposit) before it can hold VALT.
- The war chest account cannot muster.

What it does not do:

- **It does not identify people.** Anyone with N × `min_balance` VALT can split it over N accounts and muster N times a day. A whale can reach the target alone. Every muster costs a transaction and a storage deposit per account, nothing more.
- **Farming pays when the mint is large.** A sybil that holds `min_balance` per account earns `mint_per_muster / min_balance` per day per account on good days. The rules should keep this small enough that the mint reads as a reward, not a yield.
- **Coins can move between days.** The lock ends when the day ends, so one stack of coins can muster for a different account every day.
- **No proof of personhood.** The previous build used World ID tiers. Nothing equivalent exists here. A real launch should consider a personhood check, a holding-age requirement, or weighting musters by balance.

## Other limits

- Each account with an unclaimed muster keeps a small record that the contract pays storage for. The record is removed when the reward is claimed.
- Time comes from block timestamps, so a day boundary can be off by a block (about one second).
- A day only closes when somebody calls the contract. The views project the result, and the outcome does not depend on who closes it or when.
- An account that force-unregisters burns its own balance (`forced unregister`). Accounts with an unclaimed muster cannot unregister.

## Launch

```bash
scripts/launch-valt-testnet.sh <suffix>
```

The script builds the contract, creates `valtrum-valt-<suffix>.testnet`, deploys and initialises it in one transaction, then deletes the account's only access key and lists the keys to show that none are left. After that the account can only run its own code. The sandbox test `contracts/integration/tests/valt.rs` does the same launch in a single batch (deploy, `new`, delete key) and checks that the contract has no keys.

## VALT and the arena

The arena does not depend on VALT, and VALT does not depend on the arena. VALT can be one side of an arena battle like any other NEP-141 coin. When VALT wins, the arena's 5% burn share buys VALT and sends it to the arena's burn account. That account is an ordinary account today (see the security review), so the arena burn is not yet a supply burn the way VALT's own `burn` is.
