# Flow with war bonds and the furnace

This is the end-to-end flow once both OpenSpec changes are applied: `add-war-bonds` (WAR, the prize reserve) and `add-verifiable-burn` (the furnace, the burn leaderboard). For today's flow, see [architecture.md](architecture.md).

**Status:**
- WAR contract: built (mferdinandr/valtrum#35)
- furnace: not built yet
- arena wiring for both: not built yet

The numbers below follow the specs.

## Who does what

| Part | Role in the flow | Keys after launch |
| --- | --- | --- |
| Player | proposes, deposits, claims, holds WAR | own wallet |
| Arena | battles, vaults, settlement, prize reserve | owner and agent keys |
| Router + DEX | swap USDC into a side's coin, and back at settlement | owner key |
| Agent | audit, lock prices, settle, drive steps, watchdog | agent key |
| **WAR** | war bonds: mint, hourly melt, redeem, release melt | **none** |
| **Furnace** | keeps burned coins forever, keeps the burn ledger | **none** |
| Treasury | receives the 5% fee | treasury key |

## 1. Battle lifecycle

The statuses do not change. What is new is where the prize bonus, WAR and the furnace come in. A battle locks its bonus when it is approved, so players see the bonus before they deposit.

```mermaid
stateDiagram-v2
    [*] --> Proposed: bond in USDC
    Proposed --> Approved: agent audit passes
    Proposed --> Voided: audit fails (bond kept)
    Approved --> Live: deposit window ends, agent sets start prices
    Approved --> Voided: a side is empty
    Approved --> EmergencyHalted: liquidity drops over 50%
    Live --> EmergencyHalted: liquidity drops over 50%
    Live --> Voided: tie
    Live --> Settling: end time, agent sends final prices
    Settling --> Settled: every step booked
    Settled --> [*]: winners claim

    note right of Approved
      Bonus locked: draw_bps of the prize reserve,
      shown on the battle for the whole deposit window.
    end note
    note right of Settling
      Dump booked: proceeds plus the battle's bonus, split 55/35/5/5.
      Burn: winner coin into the furnace.
    end note
    note right of Settled
      Claim: principal and liquid share,
      plus the 35% share minted as WAR.
    end note
    note left of Voided
      Empty side, tie and halted battles return their bonus
      to the reserve. Audit failures never lock one.
    end note
```

## 2. Deposit with WAR (PRD example: 35 from credit + 15 from the wallet)

The player sends WAR to the arena. The message can top up from the player's internal USDC balance, so mixed funding is one action. WAR is always used in full before USDC.

```mermaid
sequenceDiagram
    actor P as Player
    participant W as WAR
    participant A as Arena
    participant R as Router + DEX
    P->>W: ft_transfer_call(arena, 35 WAR, deposit: battle, side, top-up 15)
    W->>A: ft_on_transfer(player, 35 WAR)
    A->>A: take 15 USDC from the player's internal balance
    A->>W: redeem(35)
    W->>W: burn 35 WAR (ft_burn "redeem"), backing -35
    W->>A: 35 USDC (USDC ft_transfer)
    A->>R: 50 USDC, swap to the side's coin
    R->>A: coin + deposit message
    A->>A: position booked for the player
    Note over A,W: If the swap fails, the arena pays the 35 USDC back into WAR<br/>to re-mint 35 WAR for the player and restores the 15 USDC.
```

## 3. Settlement and claim

```mermaid
sequenceDiagram
    participant G as Agent
    participant A as Arena
    participant D as DEX
    participant K as Winner coin
    participant F as Furnace
    participant U as USDC
    participant W as WAR
    participant T as Treasury
    actor P as Winner
    G->>A: approve_battle (audit passed)
    A->>A: bonus = draw_bps of the prize reserve, locked in the battle
    Note over A: The battle page shows the bonus during the deposit window.<br/>Deposits happen here (section 2).
    G->>A: settle_battle(final prices)
    G->>A: execute_step(Dump)
    A->>D: sell the loser vault
    D->>A: USDC proceeds
    A->>A: profit = proceeds + the battle's bonus
    A->>A: split 55 / 35 / 5 / 5
    G->>A: execute_step(Buy 55%)
    A->>D: USDC to winner coin (liquid pool)
    G->>A: execute_step(Burn 5%)
    A->>D: USDC to winner coin
    A->>K: storage_deposit(furnace), so the burn cannot fail on registration
    A->>K: ft_transfer_call(furnace, amount, {"battle_id"})
    K->>F: ft_on_transfer
    F->>F: ledger: coin total + battle entry, event furnace_burned
    Note over A,F: A failed burn stays pending, and anyone can call retry_burn(battle_id).
    G->>A: execute_step(Return 5%)
    A->>T: fee (flush_treasury)
    P->>A: claim(battle)
    A->>P: principal + liquid share (liquid balance)
    A->>U: ft_transfer_call(WAR, 35% share, {"action":"mint","receiver_id":winner})
    U->>W: ft_on_transfer(arena, amount)
    W->>W: mint 1:1 to the winner (ft_mint "war bond")
    Note over A,W: If the mint fails, it stays a pending mint that anyone can retry.<br/>The share never turns into liquid USDC.
```

## 4. The melt loop

WAR melts 4380 ppm every hour (10% per day). The USDC behind the melted value is not lost: anyone moves it to the prize reserve, and every battle that is approved locks a fixed share of the reserve as its bonus. The bonus is shown during deposits and joins the profit at settlement.

```mermaid
flowchart LR
    C[Winner claims] -->|35% of profit as USDC| M[WAR minted 1:1]
    M --> H[Player holds WAR]
    H -->|every hour: -0.4380%| H
    H -->|deposit into a battle| R[Arena redeems WAR for USDC]
    R --> B[Battle]
    H -.->|melted value| MB[Melted backing in WAR]
    MB -->|release_melt, anyone| PR[Prize reserve in the arena]
    PR -->|draw_bps of the reserve, locked when a battle is approved| BON[Battle bonus, shown during deposits]
    BON -->|added at settlement| S[Profit before the split]
    BON -.->|returned if no winner| PR
    B --> S
    S --> C
```

## 5. Worked example

Assumptions: the reserve starts empty, and `draw_bps` is 20%. The draw share is still open (to be picked by the simulation), so 20% is only for illustration.

**Battle 1:** PEPE beats SHIB. It was approved while the reserve was empty, so its bonus is 0. The dump realizes 40 USDC.

| Share | Amount | Goes to |
| --- | --- | --- |
| 55% liquid | 22 USDC → PEPE | winner, liquid |
| 35% WAR | 14 USDC | 14 WAR minted to the winner |
| 5% burn | 2 USDC → PEPE | furnace, recorded under battle 1 |
| 5% fee | 2 USDC | treasury |

**Three days later**, the winner still holds the WAR:

| | Amount |
| --- | --- |
| WAR balance | 14 × (1 − 0.00438)^72 = **10.206294 WAR** |
| Melted | 3.793706 USDC (about; the supply rounds up by up to 2 units) |
| After `release_melt` | the prize reserve holds about 3.79 USDC |

**Battle 2**, approved after the release:
- **Approval.** The battle locks 20% of the reserve, **0.758741 USDC**, as its bonus. The battle page shows "+0.758741 USDC bonus" for the whole deposit window.
- **Deposit.** The winner deposits 25 USDC in one action: 10.206294 WAR plus 14.793706 USDC topped up from the internal balance.
- **Settlement.** The battle settles with a dump of 40 USDC. With the bonus, the profit is **40.758741 USDC**:
  - 22.417307 liquid
  - 14.265559 WAR
  - 2.037937 burned
  - 2.037938 fee
- **Reserve.** About 3.03 USDC stays in the reserve for the next battles that are approved. Had battle 2 been halted, its 0.758741 USDC would have gone back to the reserve.

The 3.79 USDC that the winner let melt went back into prizes instead of staying stranded in the arena, which is what happens to expired credit today.

## 6. What the pages show

- **Portfolio:**
  - WAR balance
  - the loss at the next hour, and a countdown to it
  - a deposit action that uses WAR first
- **Battle page:**
  - the battle's bonus, from approval on, so it is visible during the deposit window
  - the amount burned into the furnace
- **Burn leaderboard:** coins ranked by `burned / ft_total_supply`, each with its battle history, the furnace account and its balance.
- **Token pages:** WAR rules from `get_params`, supply, backing and melted backing from `get_state`.

## Trust, in one place

- **Nobody can change** the WAR or furnace rules or code. Neither account has a key.
- **The arena owner can still upgrade the arena.** A malicious upgrade could take the prize reserve and anything in flight inside the arena, or skip future burns. It cannot touch WAR that holders keep, WAR's backing, or coins already in the furnace.
- **The agent still drives approval and settlement.** A bonus is locked when it approves, and the bonus and the burn are paid when it settles. If it stops, WAR keeps melting and the melt can still be released, but no new battle locks a bonus and locked bonuses wait in their battles.
