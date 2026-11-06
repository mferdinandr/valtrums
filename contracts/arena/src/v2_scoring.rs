//! Pure exact scoring for multi-community battles. Observation authentication, token identity,
//! finality, circulating-supply provenance and complete volume evidence belong to the caller.
//! This engine does not stop a battle because a price or liquidity falls.

use near_sdk::json_types::{U128, U64};
use near_sdk::near;
use std::cmp::Ordering;
use std::collections::BTreeSet;

mod wide {
    #![allow(clippy::all)]
    uint::construct_uint! { pub struct U512(8); }
}
use wide::U512;

pub const ROUND_DURATION_NS: u64 = 30_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    PricePercentGain,
    MarketCapPercentGrowth,
    VolumeToInitialMarketCap,
    LowestMaximumDrawdown,
}

/// Values are fixed-point unsigned atoms. Each scale is atoms per one whole unit.
/// Price, circulating supply and USD volume may use different positive scales.
/// Initial/final values and all price samples share their respective declared scale.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observation {
    pub community_id: u32,
    pub price_start: U128,
    pub price_end: Option<U128>,
    pub circulating_supply_start: Option<U128>,
    pub circulating_supply_end: Option<U128>,
    pub volume_usd: Option<U128>,
    pub price_scale: U128,
    pub supply_scale: U128,
    pub volume_scale: U128,
    pub price_samples: Vec<PriceSample>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceSample {
    pub timestamp_ns: U64,
    pub price: U128,
}

/// The arena must pin this window and its sampling policy before collecting scores.
/// A late resolution still uses this recorded window, never the worker's current price.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Window {
    pub start_ns: U64,
    pub end_ns: U64,
    pub max_sample_gap_ns: U64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScoringError {
    InvalidWindow,
    InvalidScale,
    NonpositiveValue,
    MissingObservation,
    IncompleteSamples,
    InvalidSampleOrder,
    ConflictingEndpoint,
    TooFewCandidates,
    DuplicateCommunity,
    Overflow,
}

/// Canonical sign/magnitude fraction. Fields remain private so invalid denominators and
/// negative zero cannot enter comparisons. It is not a displayed/rounded percentage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExactScore {
    negative: bool,
    numerator: U512,
    denominator: U512,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScoreView {
    pub negative: bool,
    /// Decimal strings retain up to 512 bits without JavaScript number conversion.
    pub numerator: String,
    pub denominator: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommunityScore {
    pub community_id: u32,
    pub score: ScoreView,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundScores {
    /// A single ID is the winner; multiple IDs are the only next-round candidates.
    pub leaders: Vec<u32>,
    pub scores: Vec<CommunityScore>,
}

fn gcd(mut a: U512, mut b: U512) -> U512 {
    while !b.is_zero() {
        let remainder = a % b;
        a = b;
        b = remainder;
    }
    a
}

impl ExactScore {
    fn new(negative: bool, numerator: U512, denominator: U512) -> Result<Self, ScoringError> {
        if denominator.is_zero() {
            return Err(ScoringError::NonpositiveValue);
        }
        if numerator.is_zero() {
            return Ok(Self {
                negative: false,
                numerator: U512::zero(),
                denominator: U512::one(),
            });
        }
        let divisor = gcd(numerator, denominator);
        Ok(Self {
            negative,
            numerator: numerator / divisor,
            denominator: denominator / divisor,
        })
    }

    pub fn compare(&self, other: &Self) -> Result<Ordering, ScoringError> {
        if self.negative != other.negative {
            return Ok(if self.negative {
                Ordering::Less
            } else {
                Ordering::Greater
            });
        }
        // Equal denominators need no crossproduct; this also avoids needless overflow.
        let magnitude = if self.denominator == other.denominator {
            self.numerator.cmp(&other.numerator)
        } else {
            let left = mul(self.numerator, other.denominator)?;
            let right = mul(other.numerator, self.denominator)?;
            left.cmp(&right)
        };
        Ok(if self.negative {
            magnitude.reverse()
        } else {
            magnitude
        })
    }

    pub fn view(&self) -> ScoreView {
        ScoreView {
            negative: self.negative,
            numerator: self.numerator.to_string(),
            denominator: self.denominator.to_string(),
        }
    }
}

fn mul(a: U512, b: U512) -> Result<U512, ScoringError> {
    a.checked_mul(b).ok_or(ScoringError::Overflow)
}
fn positive(value: u128) -> Result<U512, ScoringError> {
    if value == 0 {
        Err(ScoringError::NonpositiveValue)
    } else {
        Ok(U512::from(value))
    }
}
fn optional_positive(value: Option<U128>) -> Result<U512, ScoringError> {
    positive(value.ok_or(ScoringError::MissingObservation)?.0)
}
fn gain(initial: U512, final_value: U512) -> Result<ExactScore, ScoringError> {
    let negative = final_value < initial;
    let difference = if negative {
        initial.checked_sub(final_value)
    } else {
        final_value.checked_sub(initial)
    }
    .ok_or(ScoringError::Overflow)?;
    ExactScore::new(negative, difference, initial)
}
fn validate_window(window: &Window) -> Result<(), ScoringError> {
    if window.end_ns.0.checked_sub(window.start_ns.0) != Some(ROUND_DURATION_NS) {
        return Err(ScoringError::InvalidWindow);
    }
    Ok(())
}

/// Compute an exact fractional score (0.05 means 5% gain/drawdown), validating only
/// mode-specific fields. Incomplete/invalid evidence is an error, never a default score.
pub fn score_observation(
    mode: Mode,
    observation: &Observation,
    window: &Window,
) -> Result<ExactScore, ScoringError> {
    validate_window(window)?;
    if observation.price_scale.0 == 0 {
        return Err(ScoringError::InvalidScale);
    }
    let initial_price = positive(observation.price_start.0)?;
    match mode {
        Mode::PricePercentGain => gain(initial_price, optional_positive(observation.price_end)?),
        Mode::MarketCapPercentGrowth => {
            if observation.supply_scale.0 == 0 {
                return Err(ScoringError::InvalidScale);
            }
            let initial_cap = mul(
                initial_price,
                optional_positive(observation.circulating_supply_start)?,
            )?;
            let final_cap = mul(
                optional_positive(observation.price_end)?,
                optional_positive(observation.circulating_supply_end)?,
            )?;
            // Fixed price/supply scales cancel between the endpoints.
            gain(initial_cap, final_cap)
        }
        Mode::VolumeToInitialMarketCap => {
            if observation.supply_scale.0 == 0 || observation.volume_scale.0 == 0 {
                return Err(ScoringError::InvalidScale);
            }
            let volume = observation
                .volume_usd
                .ok_or(ScoringError::MissingObservation)?;
            let supply = optional_positive(observation.circulating_supply_start)?;
            let numerator = mul(
                mul(U512::from(volume.0), U512::from(observation.price_scale.0))?,
                U512::from(observation.supply_scale.0),
            )?;
            let denominator = mul(
                mul(initial_price, supply)?,
                U512::from(observation.volume_scale.0),
            )?;
            ExactScore::new(false, numerator, denominator)
        }
        Mode::LowestMaximumDrawdown => sampled_drawdown(observation, window),
    }
}

fn sampled_drawdown(
    observation: &Observation,
    window: &Window,
) -> Result<ExactScore, ScoringError> {
    let samples = &observation.price_samples;
    if samples.len() < 2
        || window.max_sample_gap_ns.0 == 0
        || window.max_sample_gap_ns.0 > ROUND_DURATION_NS
    {
        return Err(ScoringError::IncompleteSamples);
    }
    let first = samples.first().ok_or(ScoringError::MissingObservation)?;
    let last = samples.last().ok_or(ScoringError::MissingObservation)?;
    if first.timestamp_ns != window.start_ns || last.timestamp_ns != window.end_ns {
        return Err(ScoringError::IncompleteSamples);
    }
    if first.price != observation.price_start
        || observation
            .price_end
            .is_some_and(|final_price| final_price != last.price)
    {
        return Err(ScoringError::ConflictingEndpoint);
    }
    let mut peak = positive(first.price.0)?;
    let mut worst = ExactScore::new(false, U512::zero(), U512::one())?;
    let mut previous = first.timestamp_ns.0;
    for (index, sample) in samples.iter().enumerate() {
        if index > 0 {
            let gap = sample
                .timestamp_ns
                .0
                .checked_sub(previous)
                .filter(|gap| *gap > 0)
                .ok_or(ScoringError::InvalidSampleOrder)?;
            if gap > window.max_sample_gap_ns.0 {
                return Err(ScoringError::IncompleteSamples);
            }
        }
        previous = sample.timestamp_ns.0;
        let price = positive(sample.price.0)?;
        if price > peak {
            peak = price;
        }
        let loss = peak.checked_sub(price).ok_or(ScoringError::Overflow)?;
        let drawdown = ExactScore::new(false, loss, peak)?;
        if drawdown.compare(&worst)? == Ordering::Greater {
            worst = drawdown;
        }
    }
    Ok(worst)
}

/// Scores only the candidates supplied by the authoritative arena state. The caller
/// must enforce eligibility, deadlines, closed deposits, original vault locking and
/// leader-only overtime lineage. No first-arrival or random tiebreaker is applied.
pub fn select_leaders(
    mode: Mode,
    observations: &[Observation],
    window: &Window,
) -> Result<RoundScores, ScoringError> {
    validate_window(window)?;
    if observations.len() < 2 {
        return Err(ScoringError::TooFewCandidates);
    }
    let mut seen = BTreeSet::new();
    let mut best: Option<ExactScore> = None;
    let mut leaders = Vec::new();
    let mut scores = Vec::new();
    for observation in observations {
        if !seen.insert(observation.community_id) {
            return Err(ScoringError::DuplicateCommunity);
        }
        let score = score_observation(mode, observation, window)?;
        let comparison = match &best {
            Some(current) => score.compare(current)?,
            None => Ordering::Greater,
        };
        let is_better = best.is_none()
            || if mode == Mode::LowestMaximumDrawdown {
                comparison == Ordering::Less
            } else {
                comparison == Ordering::Greater
            };
        if is_better {
            leaders.clear();
            leaders.push(observation.community_id);
            best = Some(score.clone());
        } else if comparison == Ordering::Equal {
            leaders.push(observation.community_id);
        }
        scores.push(CommunityScore {
            community_id: observation.community_id,
            score: score.view(),
        });
    }
    Ok(RoundScores { leaders, scores })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window() -> Window {
        Window {
            start_ns: U64(100_000_000_000),
            end_ns: U64(130_000_000_000),
            max_sample_gap_ns: U64(10_000_000_000),
        }
    }
    fn observation(id: u32, start: u128, end: u128) -> Observation {
        Observation {
            community_id: id,
            price_start: U128(start),
            price_end: Some(U128(end)),
            circulating_supply_start: None,
            circulating_supply_end: None,
            volume_usd: None,
            price_scale: U128(1),
            supply_scale: U128(1),
            volume_scale: U128(1),
            price_samples: Vec::new(),
        }
    }
    fn fraction(negative: bool, numerator: u128, denominator: u128) -> ExactScore {
        ExactScore::new(negative, U512::from(numerator), U512::from(denominator)).unwrap()
    }
    fn path(id: u32, values: &[u128]) -> Observation {
        let mut value = observation(id, values[0], *values.last().unwrap());
        value.price_samples = values
            .iter()
            .enumerate()
            .map(|(index, price)| PriceSample {
                timestamp_ns: U64(window().start_ns.0
                    + index as u64 * ROUND_DURATION_NS / (values.len() - 1) as u64),
                price: U128(*price),
            })
            .collect();
        value
    }

    #[test]
    fn negative_gains_keep_their_sign_and_least_negative_wins() {
        let values = [
            observation(1, 100, 95),
            observation(2, 100, 90),
            observation(3, 100, 80),
        ];
        let result = select_leaders(Mode::PricePercentGain, &values, &window()).unwrap();
        assert_eq!(result.leaders, vec![1]);
        assert_eq!(result.scores[0].score, fraction(true, 1, 20).view());
    }

    #[test]
    fn exact_ties_do_not_use_rounded_basis_points() {
        let a = observation(1, 100, 110);
        let b = observation(2, 200, 220);
        assert_eq!(
            select_leaders(Mode::PricePercentGain, &[a, b], &window())
                .unwrap()
                .leaders,
            vec![1, 2]
        );
        let a = observation(1, u128::MAX - 1, u128::MAX);
        let b = observation(2, u128::MAX - 1, u128::MAX - 1);
        assert_eq!(
            select_leaders(Mode::PricePercentGain, &[a, b], &window())
                .unwrap()
                .leaders,
            vec![1]
        );
    }

    #[test]
    fn market_cap_growth_includes_circulating_supply_change() {
        let mut a = observation(1, 20, 22);
        a.circulating_supply_start = Some(U128(1000));
        a.circulating_supply_end = Some(U128(900));
        assert_eq!(
            score_observation(Mode::MarketCapPercentGrowth, &a, &window()),
            Ok(fraction(true, 1, 100))
        );
        let mut b = observation(2, 10, 10);
        b.circulating_supply_start = Some(U128(2000));
        b.circulating_supply_end = Some(U128(2100));
        assert_eq!(
            select_leaders(Mode::MarketCapPercentGrowth, &[a, b], &window())
                .unwrap()
                .leaders,
            vec![2]
        );
    }

    #[test]
    fn constant_supply_market_cap_growth_equals_price_gain() {
        let mut a = observation(1, 2, 3);
        a.circulating_supply_start = Some(U128(1000));
        a.circulating_supply_end = Some(U128(1000));
        assert_eq!(
            score_observation(Mode::MarketCapPercentGrowth, &a, &window()),
            score_observation(Mode::PricePercentGain, &a, &window())
        );
    }

    #[test]
    fn volume_ratio_uses_initial_cap_and_normalizes_unlike_scales() {
        let mut a = observation(1, 200, 99_999);
        a.price_scale = U128(100); // USD2/token
        a.circulating_supply_start = Some(U128(500_000));
        a.supply_scale = U128(1000); // 500 whole tokens -> initial cap USD1000
        a.volume_usd = Some(U128(30_000));
        a.volume_scale = U128(100); // USD300
        assert_eq!(
            score_observation(Mode::VolumeToInitialMarketCap, &a, &window()),
            Ok(fraction(false, 3, 10))
        );
        a.price_end = None; // End price/cap are not required for volume ratio.
        assert_eq!(
            score_observation(Mode::VolumeToInitialMarketCap, &a, &window()),
            Ok(fraction(false, 3, 10))
        );
        a.volume_usd = Some(U128(0));
        assert_eq!(
            score_observation(Mode::VolumeToInitialMarketCap, &a, &window()),
            Ok(fraction(false, 0, 1))
        );
    }

    #[test]
    fn drawdown_uses_interim_peak_and_minimum_score_wins() {
        let a = path(1, &[100, 120, 90, 110]);
        let b = path(2, &[100, 95, 105, 100]);
        assert_eq!(
            score_observation(Mode::LowestMaximumDrawdown, &a, &window()),
            Ok(fraction(false, 1, 4))
        );
        assert_eq!(
            select_leaders(Mode::LowestMaximumDrawdown, &[a, b], &window())
                .unwrap()
                .leaders,
            vec![2]
        );
    }

    #[test]
    fn complete_nondecreasing_paths_have_a_valid_zero_drawdown_tie() {
        let a = path(1, &[100, 110, 110, 120]);
        let b = path(2, &[1, 2, 3, 4]);
        let result = select_leaders(Mode::LowestMaximumDrawdown, &[a, b], &window()).unwrap();
        assert_eq!(result.leaders, vec![1, 2]);
        assert_eq!(result.scores[0].score, fraction(false, 0, 1).view());
    }

    #[test]
    fn missing_samples_and_duplicate_times_never_become_zero_drawdown() {
        let a = path(1, &[100, 110]); // 30s gap violates the pinned 10s cadence.
        assert_eq!(
            score_observation(Mode::LowestMaximumDrawdown, &a, &window()),
            Err(ScoringError::IncompleteSamples)
        );
        let mut a = path(1, &[100, 120, 90, 110]);
        a.price_samples[1].timestamp_ns = a.price_samples[0].timestamp_ns;
        assert_eq!(
            score_observation(Mode::LowestMaximumDrawdown, &a, &window()),
            Err(ScoringError::InvalidSampleOrder)
        );
    }

    #[test]
    fn drawdown_endpoints_must_match_the_recorded_window_and_values() {
        let mut a = path(1, &[100, 120, 90, 110]);
        a.price_samples[3].timestamp_ns.0 += 1;
        assert_eq!(
            score_observation(Mode::LowestMaximumDrawdown, &a, &window()),
            Err(ScoringError::IncompleteSamples)
        );
        let mut a = path(1, &[100, 120, 90, 110]);
        a.price_start = U128(99);
        assert_eq!(
            score_observation(Mode::LowestMaximumDrawdown, &a, &window()),
            Err(ScoringError::ConflictingEndpoint)
        );
    }

    #[test]
    fn invalid_window_scale_and_required_values_are_errors() {
        let mut w = window();
        w.end_ns.0 -= 1;
        assert_eq!(
            score_observation(Mode::PricePercentGain, &observation(1, 1, 2), &w),
            Err(ScoringError::InvalidWindow)
        );
        let mut a = observation(1, 1, 2);
        a.price_scale = U128(0);
        assert_eq!(
            score_observation(Mode::PricePercentGain, &a, &window()),
            Err(ScoringError::InvalidScale)
        );
        assert_eq!(
            score_observation(Mode::PricePercentGain, &observation(1, 0, 2), &window()),
            Err(ScoringError::NonpositiveValue)
        );
        a = observation(1, 1, 2);
        assert_eq!(
            score_observation(Mode::MarketCapPercentGrowth, &a, &window()),
            Err(ScoringError::MissingObservation)
        );
    }

    #[test]
    fn maximum_atomic_market_cap_inputs_and_crossproducts_fit_without_loss() {
        let mut a = observation(1, u128::MAX, u128::MAX - 1);
        a.circulating_supply_start = Some(U128(u128::MAX));
        a.circulating_supply_end = Some(U128(u128::MAX - 2));
        let mut b = a.clone();
        b.community_id = 2;
        b.price_end = Some(U128(u128::MAX - 2));
        assert_eq!(
            select_leaders(Mode::MarketCapPercentGrowth, &[a, b], &window())
                .unwrap()
                .leaders,
            vec![1]
        );
    }

    #[test]
    fn oversized_comparison_crossproducts_return_overflow_instead_of_wrapping() {
        let max = U512::MAX;
        let a = ExactScore::new(false, max, max - U512::one()).unwrap();
        let b = ExactScore::new(false, max - U512::from(2u8), max - U512::from(3u8)).unwrap();
        assert_eq!(a.compare(&b), Err(ScoringError::Overflow));
    }

    #[test]
    fn candidates_must_be_distinct_and_more_than_one() {
        let a = observation(1, 100, 110);
        assert_eq!(
            select_leaders(Mode::PricePercentGain, &[], &window()),
            Err(ScoringError::TooFewCandidates)
        );
        assert_eq!(
            select_leaders(Mode::PricePercentGain, &[a.clone(), a], &window()),
            Err(ScoringError::DuplicateCommunity)
        );
    }

    #[test]
    fn wire_values_are_decimal_strings_and_fraction_sign_is_separate() {
        let encoded = near_sdk::serde_json::to_value(observation(1, u128::MAX, 1)).unwrap();
        assert_eq!(encoded["price_start"], u128::MAX.to_string());
        let score = near_sdk::serde_json::to_value(fraction(true, 1, 20).view()).unwrap();
        assert_eq!(score["negative"], true);
        assert_eq!(score["numerator"], "1");
        assert_eq!(score["denominator"], "20");
    }
}
