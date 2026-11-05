# Spec Delta

## Purpose

The prize reserve collects the USDC backing that melted away from WAR and returns it to the players who keep fighting, by adding it to the profit of battles that settle.

## ADDED Requirements

### Requirement: The reserve only accepts melted WAR backing
The arena SHALL add USDC to the prize reserve only when it arrives from the WAR contract as a melt release. USDC from any other sender with the same message SHALL be refunded.

#### Scenario: Release arrives
- **WHEN** the WAR contract releases 10 USDC of melted backing
- **THEN** the prize reserve grows by 10 USDC

#### Scenario: Stranger sends USDC
- **WHEN** another account sends USDC with the melt release message
- **THEN** the USDC is refunded and the reserve does not change

### Requirement: Settling battles draw a fixed share of the reserve
When a battle's dump is booked, the arena SHALL move a fixed share of the prize reserve into that battle's profit before the 55/35/5/5 split. The share SHALL be set when the arena is initialised and SHALL have no setter.

#### Scenario: Profit boosted by the reserve
- **GIVEN** a reserve of 100 USDC and a draw of 20%
- **WHEN** a battle's dump realizes 40 USDC
- **THEN** the split applies to 60 USDC and the reserve keeps 80 USDC

### Requirement: Battles without a winner draw nothing
Battles that are voided, tied or emergency-halted SHALL not draw from the reserve.

#### Scenario: Halted battle
- **GIVEN** a reserve of 100 USDC
- **WHEN** a battle is emergency-halted
- **THEN** the reserve stays at 100 USDC

### Requirement: The reserve is public
The arena SHALL expose the reserve balance, the draw share and the amount each settled battle drew.

#### Scenario: Reading the reserve
- **WHEN** anyone reads the arena configuration and a settled battle
- **THEN** they see the current reserve, the draw share and that battle's draw
