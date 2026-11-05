# battle-credit Specification

## Purpose

Locked USDC credit that winners receive from their profit and can only spend on deposits into later battles, as the retention loop of the 55/35/5/5 rule.

## Requirements

### Requirement: Winners receive 35% of profit as credit
When a winner claims a settled battle, the arena SHALL grant the claimer their pro-rata share of the battle's credit pool (35% of the dump proceeds) as locked USDC credit.

#### Scenario: Credit granted at claim
- **GIVEN** a settled battle whose dump realized 40 USDC and a winner who owns the whole winning vault
- **WHEN** the winner claims
- **THEN** the winner's credit balance grows by 14 USDC

### Requirement: Credit expires seven days after the last grant
Credit SHALL be spendable for 7 days after it was last granted. A new grant SHALL restart the 7-day timer for the whole credit balance. Expired credit SHALL count as zero.

#### Scenario: New credit restarts the timer
- **GIVEN** an account with credit that expires in 2 days
- **WHEN** the account is granted more credit
- **THEN** the whole balance expires 7 days after the new grant

#### Scenario: Expired credit cannot be spent
- **GIVEN** an account whose credit expired
- **WHEN** it makes a deposit that would use credit
- **THEN** no credit is used and the account view shows a credit balance of zero

### Requirement: USDC deposits spend credit first
A USDC deposit SHALL be funded from the account's valid credit first, and only the remainder from the wallet or internal balance.

#### Scenario: Hybrid deposit
- **GIVEN** an account with 35 USDC of valid credit
- **WHEN** it deposits 50 USDC into a battle
- **THEN** 35 USDC comes from credit and 15 USDC from its own funds

### Requirement: Failed deposits restore credit
If a deposit that spent credit does not complete, the arena SHALL restore the spent credit without shortening its expiry.

#### Scenario: Swap refused
- **GIVEN** a USDC deposit that spent 35 USDC of credit
- **WHEN** the swap into the side's coin fails
- **THEN** the 35 USDC of credit is restored with its original expiry or later

### Requirement: Winning principal returns liquid
A winner's principal SHALL return fully liquid, including any part that was funded from credit. Only profit creates new credit.

#### Scenario: Credit-funded principal comes back liquid
- **GIVEN** a winning position of 50 USDC of which 35 came from credit
- **WHEN** the winner claims
- **THEN** the full principal is paid as liquid winner coin and new credit is granted only from the profit share
