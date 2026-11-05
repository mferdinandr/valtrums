# Spec Delta

## Purpose

The furnace is the place where Valtrum burns coins: a keyless NEAR account that keeps every coin sent to it forever and records how much of each coin was burned and by which battle.

## ADDED Requirements

### Requirement: The furnace can never release coins
The furnace SHALL have no method that transfers, withdraws or approves any coin it holds, and its account SHALL have no access key, so its code cannot be replaced.

#### Scenario: Nothing can leave
- **GIVEN** a furnace holding 2000 PEPE
- **WHEN** any account, including the deployer, tries to move those coins
- **THEN** there is no method or key that allows it

### Requirement: The furnace accepts any NEP-141 coin through a transfer call
The furnace SHALL accept every coin sent with `ft_transfer_call` and keep the full amount, returning nothing to the sender.

#### Scenario: Burn of an unknown coin
- **WHEN** an account sends 500 of a coin the furnace has never seen with `ft_transfer_call`
- **THEN** the furnace keeps all 500 and starts a ledger entry for that coin

### Requirement: Every burn is recorded by coin and by battle
For each accepted transfer call, the furnace SHALL add the amount to the coin's total and, when the message names a battle, to that battle's entry. It SHALL emit a `furnace_burned` event with the coin, amount, sender and battle.

#### Scenario: Battle burn
- **WHEN** the arena sends 2000 PEPE with a message naming battle 7
- **THEN** the PEPE total and the battle 7 entry both grow by 2000 and a `furnace_burned` event records it

#### Scenario: Burn without a battle
- **WHEN** a community member sends 100 PEPE with an empty message
- **THEN** the PEPE total grows by 100 and no battle entry changes

### Requirement: Plain transfers are kept but not counted
Coins sent with a plain `ft_transfer` SHALL stay in the furnace forever, but SHALL not be added to the ledger, because the furnace is not told about them.

#### Scenario: Plain transfer
- **WHEN** an account sends 50 PEPE to the furnace with `ft_transfer`
- **THEN** the furnace's PEPE balance grows by 50 and its recorded PEPE total does not change

### Requirement: The ledger is public
The furnace SHALL expose the recorded total per coin, a paged list of all coins with their totals, the burns of each battle, and the senders' totals per coin.

#### Scenario: Reading the ledger
- **WHEN** anyone reads the furnace views
- **THEN** they get every recorded coin with its total, and for a given battle the coins and amounts it burned
