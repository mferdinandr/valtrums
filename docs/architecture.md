# Architecture

## The game in one page

Two meme coins, A and B, fight over a period. Players put coins in the vault of the side they believe in. Prices are compared at the start and the end; the side whose coin gained more (in percent) wins.

The losing vault is sold. What it fetches is the **profit pool** for the winners, split like this:

| Share | What happens |
| --- | --- |
| 55% | bought as the winner coin and paid out liquid |
| 35% | kept as USDC and granted as **credit**, valid for 7 days |
| 5% | bought as the winner coin and burned |
| 5% | protocol fee (also absorbs rounding dust) |

Winners always get their **principal back, fully liquid**, including any part that was funded from credit. Only the profit is split. Credit is the retention loop: it can fund the next battle, and if that one is won the principal comes back liquid again while only the new profit creates new credit.

Example: a 50 USDC deposit made of 35 credit and 15 wallet funds that wins and earns a profit of 40 gets all 50 back liquid, and the 40 splits into 22 liquid, 14 credit, 2 burned and 2 fee.

Ties are voided and everyone is refunded. A rug-pull (liquidity drop over 50%) halts the battle and refunds every deposit; no reward, burn or fee is taken.

## Battle lifecycle

```
Proposed --agent audit--> Approved --deposit window closes, agent sets prices--> Live
   |                         |                                                     |
   | audit fails             | empty side / halt                                   | end time, agent sends final prices
   v                         v                                                     v
 Voided               Voided / EmergencyHalted                              Settling --all steps booked--> Settled
```

- **Proposed**: anyone sends the bond in USDC. The agent checks liquidity (above $10,000) and honeypot behaviour, then approves or voids (the bond is kept by the treasury).
- **Approved**: deposits are open until the deposit deadline.
- **Live**: deposits are locked and the 30-minute average prices at the start are recorded. A battle with an empty side is voided instead.
- **Settling**: the winner is known and the plan of execution steps is being carried out.
- **Settled**: winners claim.

## Ways to deposit

| Path | Wallet approvals | Notes |
| --- | --- | --- |
| Send the side's coin | one `ft_transfer_call` | goes straight into the vault |
| Send USDC | one `ft_transfer_call` | credit is spent first; the USDC is swapped into the side's coin by the router (user → arena → router → DEX → router → arena) and the position is credited to the sender |
| Fund the internal balance, then deposit from it | one approval to fund, none afterwards | `deposit_from_balance` needs no attached deposit, so a scoped function-call key can run it |
| Credit only | one call | `deposit_with_credit` when credit covers the whole amount |

Failed swaps are all-or-nothing: the credit and the user's USDC come back.

## Settlement

`settle_battle` decides the winner and creates a plan that starts with one `Dump` step (sell the loser vault). Reporting the dump fixes the split of its proceeds and adds `Buy`, `Burn` and `Return`. The steps are carried out in one of three modes:

1. **Agent-reported**: the agent does the work elsewhere and calls `report_execution` with the realized amounts (trusted agent).
2. **On-chain (mock DEX)**: the arena sends each step to a DEX with `execute_step` and books the amounts the DEX actually paid back. Used on testnet and in the sandbox.
3. **Foreign chain**: the arena builds an EVM transaction, asks the MPC signer (NEAR Chain Signatures) to sign it from the battle's own path, and the agent broadcasts it and reports the result.

Winners then `claim`: their principal and their share of the liquid reward land in a per-token liquid balance and the new credit is granted. `withdraw_liquid` pays tokens out.

## Components

### Contracts

| Role | Methods |
| --- | --- |
| Anyone | `ft_transfer_call` messages (`propose`, `deposit`, `deposit_usdc`, `fund_balance`), `deposit_with_credit`, `deposit_from_balance`, `claim`, `withdraw_initial_deposit`, `withdraw_liquid`, `flush_treasury` |
| Agent | `approve_battle`, `void_battle`, `set_initial_prices`, `settle_battle`, `report_execution`, `execute_step`, `emergency_halt`, `request_signature`, `retry_signature` |
| Owner | `add_agent`, `remove_agent`, `set_router`, `set_execution`, `set_foreign`, `set_treasury`, `set_bond`, `set_deposit_window_secs`, `set_paused` |

Callbacks are private. While paused, new proposals and deposits are refused; refunds, claims and withdrawals keep working.

### Agent

A loop that derives its work only from on-chain state, so restarts and duplicates are harmless: audit new proposals, lock approved battles after their deadline, settle ended battles, drive the plan, and check liquidity hourly. See [agent/README.md](../agent/README.md).

### Web and the prompt terminal

Battles, positions, credit with its expiry countdown, claims and withdrawals. The terminal parses a sentence ("All-in $WIF with my 35 USDC credit and 15 from my Base wallet") into a structured intent, validates it against the chain, shows a summary, and only then builds the transaction. If the transaction differs from the summary it aborts. See [web/README.md](../web/README.md).

## Testing

- Unit tests per contract, including the settlement math, credit rules and every state-machine rejection.
- Sandbox scenarios (`contracts/integration`): the full battle with the four-hop swap and on-chain settlement, halt, tie, void, access control, the credit loop across two battles, and the signing flow with retries.
- Agent and web tests run offline with fakes.
