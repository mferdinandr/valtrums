//! Exact score arithmetic for the redesigned arena. This module does not
//! authenticate observations or resolve a battle.
use crate::math::wide::U256;
use std::cmp::Ordering;
use std::collections::BTreeSet;

/// A round's immutable source and timing commitments. Policy and evidence
/// authentication are the responsibility of the eventual contract adapter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservationContext {
    pub battle_id: u64,
    pub round_id: u64,
    pub asset_id: String,
    pub source: String,
    pub policy_hash: String,
    pub start_ns: u64,
    pub end_ns: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservationEvidence {
    pub context: ObservationContext,
    pub observed_times_ns: Vec<u64>,
    pub evidence_hash: String,
}

/// Values are selected and frozen by an observation policy, not defaults.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SampleCoveragePolicy {
    pub boundary_tolerance_ns: u64,
    pub max_gap_ns: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundTrade {
    pub id: String,
    pub timestamp_ns: u64,
    pub quote_volume: u128,
}

/// Returns the exact sum for a complete, authenticated trade set. The caller
/// must establish completeness under its frozen market-data policy.
pub fn sum_round_volume(context: &ObservationContext, trades: &[RoundTrade]) -> Option<u128> {
    let mut ids = BTreeSet::new();
    let mut total = 0u128;
    for trade in trades {
        if trade.id.trim().is_empty()
            || !ids.insert(&trade.id)
            || trade.timestamp_ns < context.start_ns
            || trade.timestamp_ns >= context.end_ns
        {
            return None;
        }
        total = total.checked_add(trade.quote_volume)?;
    }
    Some(total)
}

/// Validate sample coverage against the supplied frozen policy. Caller must
/// authenticate evidence, policy and observation timestamps independently.
pub fn has_sample_coverage(
    expected: &ObservationContext,
    evidence: &ObservationEvidence,
    policy: &SampleCoveragePolicy,
) -> bool {
    if !matches_observation_context(expected, evidence) || policy.max_gap_ns == 0 {
        return false;
    }
    let times = &evidence.observed_times_ns;
    if times.len() < 2 {
        return false;
    }
    times[0].abs_diff(expected.start_ns) <= policy.boundary_tolerance_ns
        && times[times.len() - 1].abs_diff(expected.end_ns) <= policy.boundary_tolerance_ns
        && times
            .windows(2)
            .all(|pair| pair[1] - pair[0] <= policy.max_gap_ns)
}

/// Check identity and ordering, without asserting that samples prove coverage.
pub fn matches_observation_context(
    expected: &ObservationContext,
    evidence: &ObservationEvidence,
) -> bool {
    const ROUND_NS: u64 = 30_000_000_000;
    expected == &evidence.context
        && !expected.asset_id.trim().is_empty()
        && !expected.source.trim().is_empty()
        && !expected.policy_hash.trim().is_empty()
        && !evidence.evidence_hash.trim().is_empty()
        && expected.start_ns.checked_add(ROUND_NS) == Some(expected.end_ns)
        && !evidence.observed_times_ns.is_empty()
        && evidence
            .observed_times_ns
            .windows(2)
            .all(|pair| pair[0] < pair[1])
}

#[allow(clippy::manual_div_ceil)] // expanded by `uint::construct_uint!`
mod wide {
    uint::construct_uint! { pub struct U512(8); }
}
use wide::U512;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Score {
    negative: bool,
    numerator: U256,
    denominator: U256,
}

fn widen(value: U256) -> U512 {
    U512::from_big_endian(&value.to_big_endian())
}

impl Score {
    fn new(negative: bool, numerator: U256, denominator: U256) -> Option<Self> {
        if denominator.is_zero() {
            return None;
        }
        Some(Self {
            negative: negative && !numerator.is_zero(),
            numerator,
            denominator,
        })
    }

    pub fn compare(&self, other: &Self) -> Ordering {
        match (self.negative, other.negative) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            _ => {
                let order = (widen(self.numerator) * widen(other.denominator))
                    .cmp(&(widen(other.numerator) * widen(self.denominator)));
                if self.negative {
                    order.reverse()
                } else {
                    order
                }
            }
        }
    }
}

fn growth(start: U256, end: U256) -> Option<Score> {
    if start.is_zero() || end.is_zero() {
        return None;
    }
    if end < start {
        Score::new(true, start - end, start)
    } else {
        Score::new(false, end - start, start)
    }
}

/// Inputs must share the same declared fixed-point scale within each field.
pub fn price_gain(start: u128, end: u128) -> Option<Score> {
    growth(start.into(), end.into())
}

pub fn market_cap_growth(
    start_price: u128,
    start_supply: u128,
    end_price: u128,
    end_supply: u128,
) -> Option<Score> {
    growth(
        U256::from(start_price) * U256::from(start_supply),
        U256::from(end_price) * U256::from(end_supply),
    )
}

/// Volume and market cap must use the same quote scale; zero volume is valid.
pub fn volume_ratio(volume: u128, start_price: u128, start_supply: u128) -> Option<Score> {
    Score::new(
        false,
        volume.into(),
        U256::from(start_price) * U256::from(start_supply),
    )
}

/// Computes maximum peak-to-trough fraction; coverage is validated separately.
pub fn maximum_drawdown(prices: &[u128]) -> Option<Score> {
    if prices.len() < 2 || prices.contains(&0) {
        return None;
    }
    let mut peak = prices[0];
    let mut worst = Score::new(false, U256::zero(), U256::one())?;
    for &price in &prices[1..] {
        peak = peak.max(price);
        let next = Score::new(false, U256::from(peak - price), U256::from(peak))?;
        if next.compare(&worst) == Ordering::Greater {
            worst = next;
        }
    }
    Some(worst)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observation_context_rejects_mismatch_and_duplicate_times() {
        let context = ObservationContext {
            battle_id: 1,
            round_id: 2,
            asset_id: "asset".into(),
            source: "source".into(),
            policy_hash: "policy".into(),
            start_ns: 10,
            end_ns: 30_000_000_010,
        };
        let evidence = ObservationEvidence {
            context: context.clone(),
            observed_times_ns: vec![10, 30_000_000_010],
            evidence_hash: "hash".into(),
        };
        assert!(matches_observation_context(&context, &evidence));
        let policy = SampleCoveragePolicy {
            boundary_tolerance_ns: 1,
            max_gap_ns: 30_000_000_000,
        };
        assert!(has_sample_coverage(&context, &evidence, &policy));
        assert!(!has_sample_coverage(
            &context,
            &evidence,
            &SampleCoveragePolicy {
                boundary_tolerance_ns: 1,
                max_gap_ns: 29_999_999_999
            }
        ));
        let mut wrong = evidence.clone();
        wrong.context.source = "other".into();
        assert!(!matches_observation_context(&context, &wrong));
        wrong = evidence.clone();
        wrong.observed_times_ns = vec![10, 10];
        assert!(!matches_observation_context(&context, &wrong));
        wrong = evidence.clone();
        wrong.context.end_ns += 1;
        assert!(!matches_observation_context(&wrong.context, &wrong));
        wrong = evidence.clone();
        wrong.observed_times_ns[0] += 2;
        assert!(!has_sample_coverage(&context, &wrong, &policy));
    }

    #[test]
    fn exact_signed_growth_and_supply_changes() {
        assert_eq!(
            price_gain(100, 95)
                .unwrap()
                .compare(&price_gain(100, 90).unwrap()),
            Ordering::Greater
        );
        assert_eq!(
            price_gain(100, 95)
                .unwrap()
                .compare(&price_gain(200, 190).unwrap()),
            Ordering::Equal
        );
        assert_eq!(
            market_cap_growth(20, 1000, 22, 900)
                .unwrap()
                .compare(&market_cap_growth(10, 2000, 10, 2100).unwrap()),
            Ordering::Less
        );
        assert!(price_gain(0, 1).is_none());
        assert!(market_cap_growth(1, 1, 1, 0).is_none());
    }

    #[test]
    fn round_volume_is_half_open_deduplicated_checked_and_zero_is_complete() {
        let start = 1_000;
        let context = ObservationContext {
            battle_id: 1,
            round_id: 1,
            asset_id: "asset".into(),
            source: "source".into(),
            policy_hash: "policy".into(),
            start_ns: start,
            end_ns: start + 30_000_000_000,
        };
        let trade = |id: &str, timestamp_ns, quote_volume| RoundTrade {
            id: id.into(),
            timestamp_ns,
            quote_volume,
        };
        // A complete round without trades is a valid zero.
        assert_eq!(sum_round_volume(&context, &[]), Some(0));
        // A trade at t0 counts; one at t1 or before t0 invalidates the set.
        assert_eq!(
            sum_round_volume(&context, &[trade("a", start, 5), trade("b", start + 1, 6)]),
            Some(11)
        );
        assert_eq!(
            sum_round_volume(&context, &[trade("a", context.end_ns, 5)]),
            None
        );
        assert_eq!(
            sum_round_volume(&context, &[trade("a", start - 1, 5)]),
            None
        );
        // Duplicate or blank identifiers and total overflow are rejected, not clamped.
        assert_eq!(
            sum_round_volume(&context, &[trade("a", start, 1), trade("a", start, 1)]),
            None
        );
        assert_eq!(sum_round_volume(&context, &[trade(" ", start, 1)]), None);
        assert_eq!(
            sum_round_volume(
                &context,
                &[trade("a", start, u128::MAX), trade("b", start, 1)]
            ),
            None
        );
        // Nonpositive start values never produce a score.
        assert!(volume_ratio(1, 0, 5).is_none());
        assert!(volume_ratio(1, 5, 0).is_none());
        assert!(market_cap_growth(0, 1, 1, 1).is_none());
    }

    #[test]
    fn ratio_drawdown_and_wide_comparisons() {
        assert_eq!(
            volume_ratio(300, 1, 1000)
                .unwrap()
                .compare(&volume_ratio(400, 1, 2000).unwrap()),
            Ordering::Greater
        );
        assert_eq!(
            volume_ratio(0, 1, 1)
                .unwrap()
                .compare(&volume_ratio(0, 5, 2).unwrap()),
            Ordering::Equal
        );
        assert_eq!(
            maximum_drawdown(&[100, 120, 90, 110])
                .unwrap()
                .compare(&maximum_drawdown(&[100, 95, 105, 100]).unwrap()),
            Ordering::Greater
        );
        assert_eq!(
            maximum_drawdown(&[100, 100, 110])
                .unwrap()
                .compare(&maximum_drawdown(&[1, 2]).unwrap()),
            Ordering::Equal
        );
        assert!(maximum_drawdown(&[1, 0]).is_none());
        assert_eq!(
            market_cap_growth(u128::MAX, u128::MAX, 1, 1)
                .unwrap()
                .compare(&market_cap_growth(1, 1, u128::MAX, u128::MAX).unwrap()),
            Ordering::Less
        );
    }
}
