# Spec Delta

## MODIFIED Requirements

### Requirement: Winners receive 35% of profit as credit
When a winner claims a settled battle, the arena SHALL mint the claimer their pro-rata share of the battle's credit pool (35% of the boosted profit) as WAR, delivering the matching USDC to the WAR contract.

#### Scenario: Credit granted at claim
- **GIVEN** a settled battle whose profit was 40 USDC and a winner who owns the whole winning vault
- **WHEN** the winner claims
- **THEN** the winner receives 14 WAR, backed by 14 USDC held by the WAR contract

### Requirement: USDC deposits spend credit first
A deposit SHALL be fundable from WAR and USDC together in one action. WAR SHALL be used in full before USDC.

#### Scenario: Hybrid deposit
- **GIVEN** an account holding 35 WAR and 15 USDC of internal balance
- **WHEN** it sends the 35 WAR to the arena to deposit 50 USDC into a battle
- **THEN** 35 USDC comes from redeemed WAR and 15 USDC from its internal balance

### Requirement: Failed deposits restore credit
If a deposit funded with WAR does not complete, the arena SHALL return the WAR to the depositor and any internal USDC balance it used.

#### Scenario: Swap refused
- **GIVEN** a deposit funded with 35 WAR
- **WHEN** the swap into the side's coin fails
- **THEN** the depositor receives 35 WAR again, the value it sent, and its internal balance is restored

## REMOVED Requirements

### Requirement: Credit expires seven days after the last grant
**Reason**: Replaced by the daily melt of WAR, which applies to every balance the same way and cannot be reset by a new grant.
**Migration**: See the `war-bonds` requirement "Every balance melts by the same share each day". The melt is 10% per day, so 47.8% of the value is left after 7 days and 22.9% after 14 days.
