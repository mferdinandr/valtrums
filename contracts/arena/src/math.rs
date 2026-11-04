use crate::types::Side;

/// Basis points denominator (100% = 10_000).
pub const BPS_DENOMINATOR: u128 = 10_000;

/// Errors raised by the pure math layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MathError {
    /// An initial price of zero cannot be used as a divisor.
    ZeroInitialPrice,
    /// A value does not fit the integer type used by the calculation.
    Overflow,
}

/// Result of comparing the two sides' performance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Winner(Side),
    /// Identical performance in basis points; the battle is voided and refunded.
    Tie,
}

/// Price change from `initial` to `final_price` in basis points (signed).
///
/// Uses floor-toward-zero integer division, as `i128` division does.
pub fn performance_bps(initial: u128, final_price: u128) -> Result<i128, MathError> {
    if initial == 0 {
        return Err(MathError::ZeroInitialPrice);
    }
    let initial = i128::try_from(initial).map_err(|_| MathError::Overflow)?;
    let final_price = i128::try_from(final_price).map_err(|_| MathError::Overflow)?;
    let delta = final_price
        .checked_sub(initial)
        .ok_or(MathError::Overflow)?;
    let scaled = delta.checked_mul(10_000).ok_or(MathError::Overflow)?;
    Ok(scaled / initial)
}

/// Picks the side with the higher performance; equal performance is a tie.
pub fn determine_winner(
    initial_a: u128,
    final_a: u128,
    initial_b: u128,
    final_b: u128,
) -> Result<Outcome, MathError> {
    let perf_a = performance_bps(initial_a, final_a)?;
    let perf_b = performance_bps(initial_b, final_b)?;
    Ok(match perf_a.cmp(&perf_b) {
        std::cmp::Ordering::Greater => Outcome::Winner(Side::A),
        std::cmp::Ordering::Less => Outcome::Winner(Side::B),
        std::cmp::Ordering::Equal => Outcome::Tie,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gain_and_loss_in_bps() {
        assert_eq!(performance_bps(100, 120), Ok(2_000));
        assert_eq!(performance_bps(100, 105), Ok(500));
        assert_eq!(performance_bps(100, 80), Ok(-2_000));
        assert_eq!(performance_bps(100, 100), Ok(0));
    }

    #[test]
    fn total_loss_is_minus_100_percent() {
        assert_eq!(performance_bps(100, 0), Ok(-10_000));
    }

    #[test]
    fn zero_initial_price_is_rejected() {
        assert_eq!(performance_bps(0, 100), Err(MathError::ZeroInitialPrice));
    }

    #[test]
    fn huge_prices_overflow_instead_of_wrapping() {
        assert_eq!(performance_bps(1, u128::MAX), Err(MathError::Overflow));
        assert_eq!(performance_bps(u128::MAX, 1), Err(MathError::Overflow));
    }

    #[test]
    fn side_a_outperforms() {
        // A +20%, B +5%
        assert_eq!(
            determine_winner(100, 120, 100, 105),
            Ok(Outcome::Winner(Side::A))
        );
    }

    #[test]
    fn side_b_outperforms_even_when_both_lose() {
        // A -30%, B -10%
        assert_eq!(
            determine_winner(100, 70, 100, 90),
            Ok(Outcome::Winner(Side::B))
        );
    }

    #[test]
    fn different_price_scales_compare_by_percentage() {
        // A: 0.0001 -> 0.00012 (+20%), B: 2.0 -> 2.2 (+10%)
        assert_eq!(
            determine_winner(100_000, 120_000, 2_000_000_000, 2_200_000_000),
            Ok(Outcome::Winner(Side::A))
        );
    }

    #[test]
    fn identical_performance_is_a_tie() {
        assert_eq!(determine_winner(100, 110, 200, 220), Ok(Outcome::Tie));
        assert_eq!(determine_winner(100, 100, 50, 50), Ok(Outcome::Tie));
    }

    #[test]
    fn zero_initial_price_on_either_side_fails() {
        assert_eq!(
            determine_winner(0, 1, 100, 100),
            Err(MathError::ZeroInitialPrice)
        );
        assert_eq!(
            determine_winner(100, 100, 0, 1),
            Err(MathError::ZeroInitialPrice)
        );
    }
}
