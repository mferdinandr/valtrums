# settlement-burn Specification

## Purpose

The 5% share of a battle's dump proceeds that buys the winning coin and takes it out of circulation.

## Requirements

### Requirement: Five percent of the proceeds buys the winner coin to burn
When the loser vault has been sold, the settlement plan SHALL include a burn step worth 5% of the proceeds, which buys the winner coin.

#### Scenario: Burn step added after the dump
- **GIVEN** a settling battle whose dump realized 40 USDC
- **WHEN** the dump is booked
- **THEN** the plan contains a burn step of 2 USDC that buys the winner coin

### Requirement: Burned coin goes to the configured burn account
The arena SHALL send the coin bought by the burn step to the burn account set by the owner in the execution settings. On a foreign chain it SHALL go to the configured burn address.

#### Scenario: Burn transfer succeeds
- **GIVEN** a burn step that bought 2000 PEPE on chain
- **WHEN** the step is booked
- **THEN** 2000 PEPE are transferred to the burn account and a `burned` event is emitted

#### Scenario: Burn transfer fails
- **GIVEN** a burn account that is not registered with the winner coin
- **WHEN** the burn transfer is attempted
- **THEN** a `burn_failed` event is emitted and the coin stays in the arena
