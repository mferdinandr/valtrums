//! Pure melt arithmetic. A value melts by `melt_ppm` parts per million at every
//! step boundary; after `n` steps it is `floor(value * (1 - melt_ppm / 1e6)^n)`.

/// Parts-per-million denominator.
pub const PPM: u64 = 1_000_000;

pub(crate) mod wide {
    #![allow(clippy::all)]
    uint::construct_uint! {
        pub struct U256(4);
    }
}
use wide::U256;

/// Fixed-point scale for the compounded factor (1e36). Squaring stays below
/// 2^256 because 1e36 * 1e36 = 1e72 < 1.1e77.
fn scale() -> U256 {
    U256::exp10(36)
}

/// `(1 - melt_ppm / 1e6)^steps` in 1e36 fixed point, rounded down at each
/// multiplication. Reaches zero (fully melted) for very large `steps`.
pub fn factor(melt_ppm: u32, steps: u64) -> U256 {
    let one = scale();
    if steps == 0 {
        return one;
    }
    let mut base = one * U256::from(PPM - u64::from(melt_ppm)) / U256::from(PPM);
    let mut result = one;
    let mut n = steps;
    while n > 0 {
        if n & 1 == 1 {
            result = result * base / one;
            if result.is_zero() {
                return result;
            }
        }
        n >>= 1;
        if n > 0 {
            base = base * base / one;
            // Some bit of `n` is still set, so the result would be multiplied by zero.
            if base.is_zero() {
                return U256::zero();
            }
        }
    }
    result
}

/// `value` after `steps` step boundaries, rounded down.
pub fn melt(value: u128, melt_ppm: u32, steps: u64) -> u128 {
    if steps == 0 || value == 0 {
        return value;
    }
    let out = U256::from(value) * factor(melt_ppm, steps) / scale();
    // `out <= value`, so it always fits.
    out.as_u128()
}

/// An upper bound of `value` after `steps` boundaries: at least the exact
/// compounded value, at most 2 units above it, never above `value`. The total
/// supply melts this way so it always covers the sum of balances, whose lazy
/// updates round down at different times.
pub fn melt_upper(value: u128, melt_ppm: u32, steps: u64) -> u128 {
    if steps == 0 || value == 0 {
        return value;
    }
    melt(value, melt_ppm, steps).saturating_add(2).min(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 4_380;
    const WAR: u128 = 1_000_000;

    #[test]
    fn spec_values_for_one_and_two_days() {
        assert_eq!(melt(100 * WAR, RATE, 24), 90_000_866);
        assert_eq!(melt(100 * WAR, RATE, 48), 81_001_559);
        assert_eq!(melt(90 * WAR, RATE, 24), 81_000_779);
        assert_eq!(melt(100 * WAR, RATE, 168), 47_832_913);
    }

    #[test]
    fn one_step_takes_0_438_percent() {
        assert_eq!(100 * WAR - melt(100 * WAR, RATE, 1), 438_000);
    }

    #[test]
    fn a_day_never_costs_more_than_ten_percent() {
        let v = 1_000_000_000 * WAR;
        assert!(melt(v, RATE, 24) >= v / 10 * 9);
    }

    #[test]
    fn zero_steps_or_zero_value_change_nothing() {
        assert_eq!(melt(123, RATE, 0), 123);
        assert_eq!(melt(0, RATE, 1_000), 0);
    }

    #[test]
    fn huge_step_counts_melt_to_zero_without_panicking() {
        assert_eq!(melt(u128::MAX, RATE, u64::MAX), 0);
        assert_eq!(melt(100 * WAR, RATE, 100_000), 0);
    }

    #[test]
    fn melting_in_parts_never_beats_melting_at_once() {
        // Lazy updates floor at each touch, so splitting can only lose dust.
        let v = 777_777_777;
        let at_once = melt(v, RATE, 30);
        let in_parts = melt(melt(melt(v, RATE, 7), RATE, 11), RATE, 12);
        assert!(in_parts <= at_once);
        assert!(at_once - in_parts <= 2);
    }

    #[test]
    fn the_upper_bound_covers_every_way_of_melting_in_parts() {
        let v = 987_654_321_987;
        for split in 1..30u64 {
            let parts = melt(melt(v, RATE, split), RATE, 30 - split);
            let staged_upper = melt_upper(melt_upper(v, RATE, split), RATE, 30 - split);
            assert!(staged_upper >= melt(v, RATE, 30));
            assert!(staged_upper >= parts);
        }
        assert_eq!(melt_upper(100 * WAR, RATE, 24), 90_000_868);
        assert_eq!(melt_upper(1, RATE, 5), 1);
        assert_eq!(melt_upper(0, RATE, 5), 0);
    }

    #[test]
    fn largest_values_do_not_overflow() {
        let out = melt(u128::MAX, RATE, 1);
        assert!(out < u128::MAX);
        assert!(out > u128::MAX / 100 * 99);
    }
}
