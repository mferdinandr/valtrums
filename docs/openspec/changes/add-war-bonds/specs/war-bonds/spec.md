# Spec Delta

## Purpose

WAR is an NEP-141 coin that carries a winner's locked profit share. It is backed by USDC, melts every day, and can only be turned back into USDC by funding a battle, so holding it pushes its owner back into the arena.

## ADDED Requirements

### Requirement: WAR is an NEP-141 coin
WAR SHALL implement NEP-141 (transfers, transfer calls, balances, total supply), NEP-145 storage management and NEP-148 metadata, with 6 decimals so that 1 WAR matches 1 USDC at mint.

#### Scenario: Standard wallet support
- **WHEN** a wallet calls `ft_metadata` and `ft_balance_of`
- **THEN** it receives symbol `WAR`, 6 decimals, and the account's current balance

### Requirement: Rules are fixed at launch
The melt per step, the step length and the arena account SHALL be set once when WAR is launched and SHALL be readable by anyone. No method SHALL change them, and the WAR account SHALL have no access key, so its code cannot be replaced.

#### Scenario: Reading the rules
- **WHEN** anyone calls `get_params`
- **THEN** it returns the melt per step in parts per million, the step length, the launch time and the arena account

#### Scenario: No admin path
- **GIVEN** a launched WAR contract
- **WHEN** any account, including the deployer, tries to change a rule or deploy new code
- **THEN** there is no method or key that allows it

### Requirement: Only the arena mints, and only against USDC
WAR SHALL be minted only when the arena delivers USDC to the WAR contract, in the same amount as the WAR minted. No other account SHALL be able to mint.

#### Scenario: Arena mints a winner's share
- **WHEN** the arena transfers 14 USDC to the WAR contract to mint for a winner
- **THEN** the winner receives 14 WAR and an `ft_mint` event is emitted

#### Scenario: Anyone else is refused
- **WHEN** an account other than the arena transfers USDC to the WAR contract to mint
- **THEN** no WAR is minted and the USDC is refunded

### Requirement: The melt is 10% per day, applied hourly
WAR SHALL launch with a step length of one hour and a melt of 4380 parts per million (0.4380%) per step. Over 24 steps this removes 9.9991% of a balance, so a day never costs more than 10%.

#### Scenario: Launch configuration
- **WHEN** anyone reads `get_params` after launch
- **THEN** the step length is 3600 seconds and the melt is 4380 parts per million per step

#### Scenario: No cliff at a day boundary
- **GIVEN** an account that receives 100 WAR one minute before a full hour since launch
- **WHEN** that hour passes
- **THEN** the account loses 0.438 WAR, not a whole day's melt

### Requirement: Every balance melts by the same share each step
At every step boundary counted from launch, every WAR balance and the total supply SHALL lose the melt share of their value. The value after any number of steps SHALL be the exact compounded value, rounded down to the smallest unit. Between boundaries, values SHALL not change. The melt SHALL not depend on when an account last acted.

#### Scenario: One day of melt
- **GIVEN** an account holding 100 WAR
- **WHEN** 24 hourly steps pass
- **THEN** the account's balance is 90.000866 WAR

#### Scenario: Two days of melt
- **GIVEN** an account holding 100 WAR
- **WHEN** 48 hourly steps pass
- **THEN** the account's balance is 81.001559 WAR

#### Scenario: Transfers carry current value
- **GIVEN** an account holding 90 WAR
- **WHEN** it transfers 90 WAR to a friend and 24 hourly steps pass
- **THEN** the friend's balance is 81.000779 WAR, the same melt as if the sender had kept it

### Requirement: Melting cannot be avoided by moving coins
Sending WAR to another account, to oneself through another account, or through a transfer call SHALL not restore any melted value or delay the melt.

#### Scenario: Round trip through a second account
- **GIVEN** an account holding 100 WAR that sends them to its own second account and back
- **WHEN** 24 hourly steps pass
- **THEN** the balance is 90.000866 WAR, the same as if it had never moved

### Requirement: Only the arena can redeem WAR for USDC
The WAR contract SHALL release USDC only to the arena, and only by burning WAR that the arena itself holds, one USDC for each WAR burned. Holders SHALL have no direct way to exchange WAR for USDC.

#### Scenario: Deposit with WAR
- **WHEN** a holder sends 35 WAR to the arena to deposit into a battle
- **THEN** the arena redeems the 35 WAR for 35 USDC and `ft_burn` is emitted for 35 WAR

#### Scenario: A holder tries to cash out
- **WHEN** a holder asks the WAR contract to redeem WAR it holds
- **THEN** the request is refused

### Requirement: Backing always covers the supply
The USDC held by the WAR contract SHALL always be at least the current total supply of WAR. USDC above the total supply SHALL be reported as melted backing.

#### Scenario: Backing after a day of melt
- **GIVEN** 100 WAR in circulation backed by 100 USDC
- **WHEN** 24 hourly steps pass
- **THEN** the total supply is 90.000866 WAR and the melted backing is 9.999134 USDC

### Requirement: Melted backing goes only to the prize reserve
Anyone SHALL be able to trigger the release of the melted backing. The released USDC SHALL go only to the arena's prize reserve, and a release event SHALL record the amount.

#### Scenario: Release by a stranger
- **GIVEN** 10 USDC of melted backing
- **WHEN** any account calls the release
- **THEN** 10 USDC is sent to the arena's prize reserve and a `melt_released` event records 10 USDC

### Requirement: The coin page can be built from views alone
WAR SHALL expose views for its rules, total supply, backing, melted backing, the next step boundary, and each account's balance and the value it will lose at that boundary.

#### Scenario: Account view
- **GIVEN** an account holding 100 WAR
- **WHEN** anyone reads that account's view
- **THEN** it shows a balance of 100 WAR, a loss of 0.438 WAR at the next step boundary, and the time of that boundary
