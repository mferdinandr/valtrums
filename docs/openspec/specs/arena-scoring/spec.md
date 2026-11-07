# arena-scoring Specification

## Purpose
Defines how arena battles are scored: four exact scoring modes, immutable 30-second rounds bound to frozen observation policy and evidence, repeated overtime for tied leaders, and the verified final result handed to lifecycle. Created by archiving change arena-scoring.

## Requirements

### Requirement: Four exact scoring modes
The creator SHALL select one fixed mode: Price % Gain, Market Cap % Growth, Volume-to-Market Cap Ratio, or Lowest % Drawdown. The system SHALL use the formulas in docs/battle-rules.md with exact signed/rational comparison.

#### Scenario: Negative scores
- **WHEN** price gains are -5%, -10% and -20%
- **THEN** the -5% candidate wins

#### Scenario: Circulating supply changes
- **WHEN** price changes 2 to 2.2 and circulating supply 1000 to 900
- **THEN** market-cap growth is -1%, not price growth or fully diluted growth

#### Scenario: Initial market cap
- **WHEN** round volume is 300 and initial market cap is 1000
- **THEN** volume ratio is 0.30 regardless of ending market cap

#### Scenario: Interim peak
- **WHEN** prices are 100, 120, 90, 110
- **THEN** maximum drawdown is 25%, not the start-to-end change

#### Scenario: Zero drawdown
- **WHEN** complete approved observations are nondecreasing
- **THEN** maximum drawdown is zero; missing observations cannot be treated as zero

### Requirement: Thirty-second point-observation rounds
Each round SHALL last 30 seconds without TWAP. The system SHALL require complete mode-specific evidence under a frozen source, boundary, coverage and freshness policy.

#### Scenario: Scheduler delay
- **WHEN** resolution runs late
- **THEN** it uses evidence for the recorded interval without shifting the close

#### Scenario: Missing evidence
- **WHEN** required supply, volume or drawdown coverage is missing
- **THEN** resolution remains pending without assigning zero or a default winner

### Requirement: Unlimited leader-only overtime
Tied best candidates SHALL enter fresh 30-second rounds with reset scores, volume and peaks without a cap. All original vaults SHALL remain locked and deposits closed until a unique winner.

#### Scenario: Three communities with repeated ties
- **WHEN** A/B tie in round 1, C is lower, and A/B tie again
- **THEN** only A/B advance again; C stays eliminated with its vault locked and no fees paid

#### Scenario: Fresh negative round
- **WHEN** A then scores -4% and B -5% in a fresh overtime round
- **THEN** A wins without cumulative earlier scores

#### Scenario: Evidence provenance and zero volume
- **WHEN** round data is submitted
- **THEN** it binds battle, round, source, observation times and frozen coverage policy; complete zero volume is valid while missing evidence is not
