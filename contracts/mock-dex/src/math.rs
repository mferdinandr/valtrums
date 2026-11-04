mod wide {
    #![allow(clippy::all)]
    uint::construct_uint! {
        pub struct U256(4);
    }
}
use wide::U256;

/// Computes `a * b / c` through a 256-bit intermediate (floor division).
/// Returns `None` when `c` is zero or the result does not fit `u128`.
pub fn mul_div(a: u128, b: u128, c: u128) -> Option<u128> {
    if c == 0 {
        return None;
    }
    let product = U256::from(a) * U256::from(b);
    let quotient = product / U256::from(c);
    if quotient > U256::from(u128::MAX) {
        None
    } else {
        Some(quotient.as_u128())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floors_the_quotient() {
        assert_eq!(mul_div(10, 3, 4), Some(7));
    }

    #[test]
    fn survives_u128_overflowing_product() {
        assert_eq!(mul_div(u128::MAX, 2, 4), Some(u128::MAX / 2));
    }

    #[test]
    fn rejects_zero_divisor_and_overflow() {
        assert_eq!(mul_div(1, 1, 0), None);
        assert_eq!(mul_div(u128::MAX, 2, 1), None);
    }
}
