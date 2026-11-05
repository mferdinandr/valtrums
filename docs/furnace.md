# The furnace

The furnace (`contracts/furnace`) is where Valtrum burns coins. The spec is `docs/openspec/changes/add-verifiable-burn`.

## What it does

- **Keeps everything.** It accepts any NEP-141 coin through `ft_transfer_call` and keeps the full amount: `ft_on_transfer` always returns 0.
- **Can never give anything back.** It has no method that transfers, withdraws or approves a coin. The release build exports only `new`, `ft_on_transfer`, the views below and `contract_source_metadata`. The account is launched without keys, so the code cannot be replaced either.
- **Records every burn** it is told about:
  - the total per coin
  - the amount per battle, when the message is `{"battle_id": <id>}`
  - the amount per sender
  
  Each burn emits `furnace_burned` (standard `furnace`) with the coin, amount, sender and battle.

## Views

| View | Returns |
| --- | --- |
| `get_total(token_id)` | recorded total of one coin |
| `get_coin_count()` | number of coins with a recorded burn |
| `get_coins(from_index, limit)` | coins with totals, in the order they first arrived, at most 100 per page |
| `get_battle_burns(battle_id)` | coins and amounts that one battle burned |
| `get_sender_total(token_id, sender_id)` | what one sender burned of one coin |

## What it does not count

- **Plain `ft_transfer`s.** The coin contract does not tell the furnace about them, so they stay in the furnace forever but are not in the ledger. A coin's `ft_balance_of(furnace)` is therefore at least its recorded total.
- **Malformed messages.** Messages that do not name a battle as a number (`{}`, `{"battle_id":"7"}`, plain text) are recorded as burns without a battle.
- **Lies from a malicious coin.** The ledger records what a coin contract reported, so a malicious coin can report transfers that never happened. The leaderboard should show both the recorded total and the furnace's balance.

## Supply

NEP-141 has no standard burn call, so a coin's `ft_total_supply` still includes what sits in the furnace. The leaderboard's share is `burned / ft_total_supply`: the part of all coins that Valtrum took out of circulation.

## Costs

The furnace pays storage for each new coin, battle entry and sender entry. Fund it with NEAR at launch and watch its balance. If it runs out of storage, `ft_on_transfer` fails and the coin is refunded to the sender, so nothing is lost; the burn can be retried once the furnace is topped up.
