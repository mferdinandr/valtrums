//! Exact signed rational scoring for the four modes (docs/battle-rules.md).
//!
//! All scores are integer-scaled inputs reduced to rationals and compared by
//! exact cross multiplication. No binary floating point anywhere; a tie means
//! exact equality at the frozen input precision.

use near_sdk::require;
use std::cmp::Ordering;
use uint::construct_uint;

construct_uint! {
    /// 256-bit unsigned integer for wide checked math.
    pub struct U256(4);
}

/// A rational `(-1)^negative * num / den` with `den > 0`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rational {
    pub negative: bool,
    pub num: U256,
    pub den: U256,
}

impl Rational {
    pub fn from_signed_parts(negative: bool, num: u128, den: u128) -> Self {
        require!(den > 0, "Nonpositive denominator");
        let (negative, num) = if num == 0 {
            (false, U256::zero())
        } else {
            (negative, U256::from(num))
        };
        Rational {
            negative,
            num,
            den: U256::from(den),
        }
    }

    pub fn from_parts(num: u128, den: u128) -> Self {
        Self::from_signed_parts(false, num, den)
    }

    /// Exact comparison: `a/b vs c/d` via cross multiplication, sign-aware.
    pub fn cmp(&self, other: &Rational) -> Ordering {
        let left = self.num * other.den;
        let right = other.num * self.den;
        match (self.negative, other.negative) {
            (false, false) => left.cmp(&right),
            (true, true) => right.cmp(&left),
            (false, true) => Ordering::Greater,
            (true, false) => Ordering::Less,
        }
    }

    pub fn is_zero(&self) -> bool {
        self.num.is_zero()
    }
}

impl PartialOrd for Rational {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Rational {
    fn cmp(&self, other: &Self) -> Ordering {
        Rational::cmp(self, other)
    }
}

/// The score of one community in one round.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Score {
    pub value: Rational,
}

/// Computes the Price % Gain: `100*(P1-P0)/P0`. The 100 factor cancels in
/// comparisons, so it is omitted.
pub fn price_gain(start_price: u128, end_price: u128) -> Score {
    require!(start_price > 0, "Nonpositive start price");
    require!(end_price > 0, "Nonpositive end price");
    let negative = end_price < start_price;
    let num = if negative {
        start_price - end_price
    } else {
        end_price - start_price
    };
    Score {
        value: Rational::from_signed_parts(negative, num, start_price),
    }
}

/// Computes the Market Cap % Growth from price x circulating supply.
pub fn market_cap_growth(
    start_price: u128,
    start_supply: u128,
    end_price: u128,
    end_supply: u128,
) -> Score {
    require!(start_price > 0 && end_price > 0, "Nonpositive price");
    require!(
        start_supply > 0 && end_supply > 0,
        "Invalid circulating supply"
    );
    let start_mc = U256::from(start_price) * U256::from(start_supply);
    let end_mc = U256::from(end_price) * U256::from(end_supply);
    let negative = end_mc < start_mc;
    let diff = if negative {
        start_mc - end_mc
    } else {
        end_mc - start_mc
    };
    Score {
        value: Rational {
            negative,
            num: diff,
            den: start_mc,
        },
    }
}

/// Computes the Volume-to-Market Cap Ratio: `V / M0`, dimensionless.
pub fn volume_ratio(volume: u128, start_price: u128, start_supply: u128) -> Score {
    require!(start_price > 0, "Nonpositive start price");
    require!(start_supply > 0, "Invalid circulating supply");
    require!(volume > 0, "Negative volume");
    let start_mc = U256::from(start_price) * U256::from(start_supply);
    Score {
        value: Rational {
            negative: false,
            num: U256::from(volume),
            den: start_mc,
        },
    }
}

/// Computes the maximum peak-to-trough drawdown over the ordered price path:
/// `max_k((peak_k - p_k) / peak_k)`. A complete nondecreasing path scores 0.
pub fn max_drawdown(path: &[u128]) -> Score {
    require!(path.len() >= 2, "Drawdown path too short");
    let mut peak = U256::from(path[0]);
    let mut worst_num = U256::zero();
    let mut worst_den = U256::one();
    for price in path {
        require!(*price > 0, "Nonpositive price in path");
        let p = U256::from(*price);
        if p > peak {
            peak = p;
        }
        let depth_num = peak - p;
        let depth_den = peak;
        // depth_num/depth_den > worst_num/worst_den ?
        if depth_num * worst_den > worst_num * depth_den {
            worst_num = depth_num;
            worst_den = depth_den;
        }
    }
    Score {
        value: Rational {
            negative: false,
            num: worst_num,
            den: worst_den,
        },
    }
}

/// Which direction wins for a mode.
pub fn best_is_highest(mode: crate::types::ScoringMode) -> bool {
    !matches!(mode, crate::types::ScoringMode::LowestDrawdown)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rat(n: u128, d: u128) -> Rational {
        Rational::from_parts(n, d)
    }

    #[test]
    fn gain_negative_scores_compare_correctly() {
        // -5% vs -10% vs -20%: -5% wins.
        let a = price_gain(100, 95).value;
        let b = price_gain(100, 90).value;
        let c = price_gain(100, 80).value;
        assert_eq!(a.cmp(&b), Ordering::Greater);
        assert_eq!(b.cmp(&c), Ordering::Greater);
        assert_eq!(a.cmp(&c), Ordering::Greater);
        assert!(!a.is_zero());
    }

    #[test]
    fn gain_positive_vs_negative() {
        let up = price_gain(100, 110).value;
        let down = price_gain(100, 90).value;
        assert_eq!(up.cmp(&down), Ordering::Greater);
    }

    #[test]
    fn supply_change_against_price_uses_market_cap() {
        // price 2 -> 2.2 (+10%), supply 1000 -> 900 (-10%): market cap -1%.
        let a = market_cap_growth(2, 1000, 22, 100); // scaled price: 2.0/2.2
        let _ = a;
        let mca = market_cap_growth(2_000, 1_000, 2_200, 900);
        // mc: 2,000,000 -> 1,980,000 = -1%
        let b = market_cap_growth(1_000, 2_000, 1_000, 2_100);
        // mc: 2,000,000 -> 2,100,000 = +5%
        assert_eq!(mca.value.cmp(&b.value), Ordering::Less);
        assert!(mca.value.negative);
        assert!(!b.value.negative);
    }

    #[test]
    fn volume_ratio_uses_initial_market_cap() {
        // A: 300/1000 = 0.30; B: 400/2000 = 0.20.
        let a = volume_ratio(300, 1_000, 1);
        let b = volume_ratio(400, 2_000, 1);
        assert_eq!(a.value.cmp(&b.value), Ordering::Greater);
        assert_eq!(rat(30, 100).cmp(&a.value), Ordering::Equal);
    }

    #[test]
    fn drawdown_uses_interim_peak() {
        // 100 -> 120 -> 90 -> 110: max drawdown 25% (120 -> 90), not start-end.
        let d = max_drawdown(&[100, 120, 90, 110]).value;
        assert_eq!(d.cmp(&rat(25, 100)), Ordering::Equal);
    }

    #[test]
    fn drawdown_path_comparison() {
        // A: 100 -> 95 -> 105 -> 100 (5%); B: 100 -> 95 -> 90 -> 100 (10%).
        let a = max_drawdown(&[100, 95, 105, 100]).value;
        let b = max_drawdown(&[100, 95, 90, 100]).value;
        assert_eq!(a.cmp(&b), Ordering::Less);
    }

    #[test]
    fn zero_drawdown_for_non_decreasing_path() {
        let d = max_drawdown(&[100, 110, 120, 130]).value;
        assert!(d.is_zero());
    }

    #[test]
    fn equal_zero_drawdowns_tie() {
        let a = max_drawdown(&[100, 120]).value;
        let b = max_drawdown(&[50, 80]).value;
        assert_eq!(a.cmp(&b), Ordering::Equal);
    }

    #[test]
    fn ratio_tie_is_exact() {
        let a = volume_ratio(300, 1_000, 1).value;
        let b = volume_ratio(600, 2_000, 1).value;
        assert_eq!(a.cmp(&b), Ordering::Equal);
    }
}
