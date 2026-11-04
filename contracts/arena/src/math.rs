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
    /// A vault or denominator of zero cannot be used as a divisor.
    DivisionByZero,
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

/// Share of profit paid as liquid winner coin (55%).
pub const LIQUID_BPS: u128 = 5_500;
/// Share of profit granted as locked USDC credit (35%).
pub const CREDIT_BPS: u128 = 3_500;
/// Share of profit burned as winner coin (5%).
pub const BURN_BPS: u128 = 500;
/// Share of profit sent to the protocol treasury (5%). Also absorbs rounding dust.
pub const FEE_BPS: u128 = 500;

const _: () = assert!(LIQUID_BPS + CREDIT_BPS + BURN_BPS + FEE_BPS == BPS_DENOMINATOR);

pub(crate) mod wide {
    #![allow(clippy::all)]
    uint::construct_uint! {
        pub struct U256(4);
    }
}
use wide::U256;

/// `floor(a * b / denominator)` computed with a 256-bit intermediate so large
/// 18-decimal amounts never overflow before the division.
pub fn mul_div_floor(a: u128, b: u128, denominator: u128) -> Result<u128, MathError> {
    if denominator == 0 {
        return Err(MathError::DivisionByZero);
    }
    let result = U256::from(a) * U256::from(b) / U256::from(denominator);
    if result > U256::from(u128::MAX) {
        return Err(MathError::Overflow);
    }
    Ok(result.as_u128())
}

/// A profit amount divided into the four 55/35/5/5 shares.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProfitSplit {
    /// 55%: swapped to the winner coin and paid out liquid.
    pub liquid: u128,
    /// 35%: locked USDC credit, valid for 7 days.
    pub credit: u128,
    /// 5%: winner coin sent to the dead address.
    pub burn: u128,
    /// 5% plus any rounding remainder: protocol treasury.
    pub fee: u128,
}

impl ProfitSplit {
    pub fn total(&self) -> u128 {
        self.liquid + self.credit + self.burn + self.fee
    }
}

/// Splits `profit` 55/35/5/5 with floor division. The fee takes the remainder,
/// so the four shares always sum to exactly `profit`.
pub fn split_profit(profit: u128) -> Result<ProfitSplit, MathError> {
    let liquid = mul_div_floor(profit, LIQUID_BPS, BPS_DENOMINATOR)?;
    let credit = mul_div_floor(profit, CREDIT_BPS, BPS_DENOMINATOR)?;
    let burn = mul_div_floor(profit, BURN_BPS, BPS_DENOMINATOR)?;
    let fee = profit - liquid - credit - burn;
    Ok(ProfitSplit {
        liquid,
        credit,
        burn,
        fee,
    })
}

/// A winner's pro-rata share of the loser vault:
/// `position_amount / winner_vault * loser_vault`, floored.
pub fn profit_share(
    position_amount: u128,
    winner_vault: u128,
    loser_vault: u128,
) -> Result<u128, MathError> {
    mul_div_floor(position_amount, loser_vault, winner_vault)
}

/// Everything a winning position receives at settlement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PositionPayout {
    /// Original stake, returned 100% liquid (including any credit-funded part).
    pub principal: u128,
    /// The 55/35/5/5 split of the position's profit.
    pub profit: ProfitSplit,
}

/// Principal returns in full; only the profit is split 55/35/5/5.
pub fn payout_for_position(
    position_amount: u128,
    winner_vault: u128,
    loser_vault: u128,
) -> Result<PositionPayout, MathError> {
    let profit = profit_share(position_amount, winner_vault, loser_vault)?;
    Ok(PositionPayout {
        principal: position_amount,
        profit: split_profit(profit)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(liquid: u128, credit: u128, burn: u128, fee: u128) -> ProfitSplit {
        ProfitSplit {
            liquid,
            credit,
            burn,
            fee,
        }
    }

    #[test]
    fn prd_example_profit_40_splits_22_14_2_2() {
        assert_eq!(split_profit(40), Ok(split(22, 14, 2, 2)));
    }

    #[test]
    fn rounding_remainder_goes_to_fee() {
        // 33 * 55% = 18.15 -> 18, 35% = 11.55 -> 11, 5% = 1.65 -> 1, fee = 33 - 30 = 3
        let result = split_profit(33).unwrap();
        assert_eq!(result, split(18, 11, 1, 3));
        assert_eq!(result.total(), 33);
    }

    #[test]
    fn zero_profit_splits_to_zero() {
        assert_eq!(split_profit(0), Ok(split(0, 0, 0, 0)));
    }

    #[test]
    fn tiny_profit_is_all_fee() {
        assert_eq!(split_profit(1), Ok(split(0, 0, 0, 1)));
    }

    #[test]
    fn split_always_sums_to_profit() {
        for profit in 0..5_000u128 {
            assert_eq!(split_profit(profit).unwrap().total(), profit);
        }
        for profit in [u128::MAX, u128::MAX - 1, u128::MAX / 3, 10u128.pow(36) + 7] {
            assert_eq!(split_profit(profit).unwrap().total(), profit);
        }
    }

    #[test]
    fn mul_div_handles_products_beyond_u128() {
        // 10^30 * 10^30 overflows u128 before the division.
        let big = 10u128.pow(30);
        assert_eq!(mul_div_floor(big, big, big), Ok(big));
        assert_eq!(mul_div_floor(u128::MAX, 2, 4), Ok(u128::MAX / 2));
    }

    #[test]
    fn mul_div_reports_overflow_and_zero_division() {
        assert_eq!(
            mul_div_floor(u128::MAX, u128::MAX, 1),
            Err(MathError::Overflow)
        );
        assert_eq!(mul_div_floor(1, 1, 0), Err(MathError::DivisionByZero));
    }

    #[test]
    fn profit_share_is_pro_rata() {
        // 25% of the winner vault, loser vault is 160 -> 40
        assert_eq!(profit_share(25, 100, 160), Ok(40));
        assert_eq!(profit_share(100, 100, 160), Ok(160));
        assert_eq!(profit_share(0, 100, 160), Ok(0));
    }

    #[test]
    fn profit_share_floors() {
        assert_eq!(profit_share(1, 3, 10), Ok(3));
    }

    #[test]
    fn profit_share_with_empty_winner_vault_fails() {
        assert_eq!(profit_share(0, 0, 160), Err(MathError::DivisionByZero));
    }

    #[test]
    fn shares_never_exceed_loser_vault() {
        let winner_vault = 1_000_003u128;
        let loser_vault = 777_777u128;
        let positions = [1u128, 999, 123_456, 500_000, 375_547];
        assert_eq!(positions.iter().sum::<u128>(), winner_vault);
        let total: u128 = positions
            .iter()
            .map(|p| profit_share(*p, winner_vault, loser_vault).unwrap())
            .sum();
        assert!(total <= loser_vault);
        // each floor loses less than 1 unit
        assert!(loser_vault - total < positions.len() as u128);
    }

    #[test]
    fn payout_returns_full_principal_and_splits_only_profit() {
        // PRD: a hybrid 50 position (35 from credit) wins a 40 profit.
        let payout = payout_for_position(50, 50, 40).unwrap();
        assert_eq!(payout.principal, 50);
        assert_eq!(payout.profit, split(22, 14, 2, 2));
    }

    #[test]
    fn payout_with_18_decimal_amounts() {
        let unit = 10u128.pow(18);
        let payout = payout_for_position(500_000 * unit, 2_000_000 * unit, 800_000 * unit).unwrap();
        assert_eq!(payout.principal, 500_000 * unit);
        // 25% of 800_000 = 200_000 profit
        assert_eq!(payout.profit.total(), 200_000 * unit);
        assert_eq!(payout.profit.liquid, 110_000 * unit);
        assert_eq!(payout.profit.credit, 70_000 * unit);
        assert_eq!(payout.profit.burn, 10_000 * unit);
        assert_eq!(payout.profit.fee, 10_000 * unit);
    }

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
