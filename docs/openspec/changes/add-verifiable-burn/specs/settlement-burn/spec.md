# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: Burned coin goes to the configured burn account`
- TO: `### Requirement: Burned coin goes to the furnace`

## MODIFIED Requirements

### Requirement: Burned coin goes to the furnace
The arena SHALL send the coin bought by the burn step to the furnace with a transfer call naming the battle. The furnace account SHALL be fixed when the arena is initialised and SHALL have no setter. On a foreign chain the coin SHALL go to `0x000000000000000000000000000000000000dEaD`, a constant.

#### Scenario: Burn transfer succeeds
- **GIVEN** a burn step that bought 2000 PEPE on chain
- **WHEN** the step is booked
- **THEN** 2000 PEPE are sent to the furnace for that battle and a `burned` event is emitted

#### Scenario: Burn transfer fails
- **GIVEN** a burn transfer that fails for any reason
- **WHEN** the failure is reported back to the arena
- **THEN** a `burn_failed` event is emitted and the coin is kept as a pending burn of that battle

#### Scenario: Owner tries to redirect the burn
- **WHEN** the owner changes the execution or foreign-chain settings
- **THEN** no setting exists that changes the furnace account or the foreign burn address

## ADDED Requirements

### Requirement: The furnace is registered before each burn
Before sending a burn, the arena SHALL register the furnace with the winner coin's storage management, paying the deposit itself, so that the burn transfer cannot fail for a missing registration.

#### Scenario: First burn of a new coin
- **GIVEN** a winner coin the furnace has never received
- **WHEN** the burn step runs
- **THEN** the furnace is registered with that coin first and the burn transfer succeeds

### Requirement: Anyone can retry a pending burn
The arena SHALL let any account retry a battle's pending burn. A successful retry SHALL clear the pending amount, and a burn SHALL never be sent twice.

#### Scenario: Retry after a failure
- **GIVEN** battle 7 has 2000 PEPE pending burn
- **WHEN** any account calls the retry for battle 7 and the transfer succeeds
- **THEN** the furnace records 2000 PEPE for battle 7 and battle 7 has nothing pending

#### Scenario: Retry with nothing pending
- **WHEN** any account calls the retry for a battle with no pending burn
- **THEN** the call is refused and nothing is sent
