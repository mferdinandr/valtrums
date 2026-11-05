# Spec Delta

## Purpose

A public page where meme communities see how much of their coin Valtrum battles have burned, so that winning has a visible, lasting effect on the coin's supply.

## ADDED Requirements

### Requirement: Coins are ranked by the share of supply burned
The page SHALL list every coin recorded by the furnace, ranked by its recorded burned amount divided by the coin's current total supply. Burned coins stay in the furnace, so they are still part of that supply.

#### Scenario: Ranking two coins
- **GIVEN** PEPE with 1% of its supply burned and SHIB with 0.2%
- **WHEN** a visitor opens the leaderboard
- **THEN** PEPE is listed above SHIB with both percentages shown

### Requirement: Each coin shows its battle history
For each coin, the page SHALL show the battles that burned it, with the amount each battle burned and a link to the battle.

#### Scenario: Opening a coin
- **WHEN** a visitor opens PEPE on the leaderboard
- **THEN** they see every battle that burned PEPE with its amount and a link to that battle

### Requirement: Figures come from the chain
The page SHALL read the furnace ledger and each coin's total supply from the chain, and SHALL show which furnace account it read.

#### Scenario: Verifying a figure
- **WHEN** a visitor compares a coin's burned figure with the furnace view on a block explorer
- **THEN** the numbers match and the page names the furnace account
