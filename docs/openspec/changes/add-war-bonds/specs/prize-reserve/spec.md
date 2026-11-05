# Spec Delta

## Purpose

The prize reserve collects the USDC backing that melted away from WAR and returns it to the players who keep fighting, as a bonus that each new battle locks when it is approved and shows during its deposit window.

## ADDED Requirements

### Requirement: The reserve only accepts melted WAR backing
The arena SHALL add USDC to the prize reserve only when it arrives from the WAR contract as a melt release. USDC from any other sender with the same message SHALL be refunded.

#### Scenario: Release arrives
- **WHEN** the WAR contract releases 10 USDC of melted backing
- **THEN** the prize reserve grows by 10 USDC

#### Scenario: Stranger sends USDC
- **WHEN** another account sends USDC with the melt release message
- **THEN** the USDC is refunded and the reserve does not change

### Requirement: Approved battles lock a fixed share of the reserve as their bonus
When a battle is approved, the arena SHALL move a fixed share of the prize reserve into that battle's bonus. The share SHALL be set when the arena is initialised and SHALL have no setter. A battle's bonus SHALL not change after approval.

#### Scenario: Bonus locked at approval
- **GIVEN** a reserve of 100 USDC and a draw of 20%
- **WHEN** a battle is approved
- **THEN** the battle's bonus is 20 USDC and the reserve keeps 80 USDC

#### Scenario: Later releases do not change an approved bonus
- **GIVEN** an approved battle with a bonus of 20 USDC
- **WHEN** 50 USDC of melted backing arrives in the reserve
- **THEN** the battle's bonus is still 20 USDC and the reserve grows by 50 USDC

#### Scenario: Battles approved one after another
- **GIVEN** a reserve of 100 USDC and a draw of 20%
- **WHEN** two battles are approved one after the other
- **THEN** the first locks 20 USDC, the second locks 16 USDC, and the reserve keeps 64 USDC

### Requirement: The bonus is visible during the deposit window
From approval on, the arena SHALL show each battle's bonus in its battle view, so players see it before they deposit.

#### Scenario: Reading an open battle
- **GIVEN** a battle approved with a bonus of 20 USDC whose deposit window is open
- **WHEN** anyone reads the battle
- **THEN** the view shows a bonus of 20 USDC

### Requirement: The bonus joins the profit when the battle settles
When a battle's dump is booked, the arena SHALL add the battle's bonus to the dump proceeds before the 55/35/5/5 split.

#### Scenario: Profit boosted by the bonus
- **GIVEN** a battle with a bonus of 20 USDC
- **WHEN** its dump realizes 40 USDC
- **THEN** the split applies to 60 USDC

### Requirement: Battles without a winner return their bonus
When an approved battle is voided for an empty side or a tie, or is emergency-halted, the arena SHALL return its whole bonus to the prize reserve. Proposals voided by the audit never lock a bonus.

#### Scenario: Halted battle
- **GIVEN** a reserve of 80 USDC and a battle with a bonus of 20 USDC
- **WHEN** the battle is emergency-halted
- **THEN** the reserve is 100 USDC and the battle's bonus is 0

#### Scenario: Proposal that fails the audit
- **GIVEN** a reserve of 100 USDC
- **WHEN** a proposal is voided by the audit
- **THEN** the reserve stays at 100 USDC

### Requirement: The reserve is public
The arena SHALL expose the reserve balance and the draw share.

#### Scenario: Reading the reserve
- **WHEN** anyone reads the arena configuration
- **THEN** they see the current reserve and the draw share
