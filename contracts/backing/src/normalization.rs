//! Exact conversion between source and representation atomic units.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Normalized {
    pub representation_units: u128,
    /// Source units not representable at the chosen precision.
    pub source_residue: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NormalizationError {
    UnsupportedScale,
    Overflow,
    Unrepresentable,
}

/// Never rounds upward; both decimal values are fixed asset configuration.
pub fn normalize(
    amount: u128,
    source_decimals: u8,
    representation_decimals: u8,
) -> Result<Normalized, NormalizationError> {
    let difference = source_decimals.abs_diff(representation_decimals);
    let factor = 10_u128
        .checked_pow(u32::from(difference))
        .ok_or(NormalizationError::UnsupportedScale)?;
    if representation_decimals >= source_decimals {
        Ok(Normalized {
            representation_units: amount
                .checked_mul(factor)
                .ok_or(NormalizationError::Overflow)?,
            source_residue: 0,
        })
    } else {
        Ok(Normalized {
            representation_units: amount / factor,
            source_residue: amount % factor,
        })
    }
}

/// Convert a representation quantity back into source units without loss.
pub fn to_source_exact(
    amount: u128,
    source_decimals: u8,
    representation_decimals: u8,
) -> Result<u128, NormalizationError> {
    let difference = source_decimals.abs_diff(representation_decimals);
    let factor = 10_u128
        .checked_pow(u32::from(difference))
        .ok_or(NormalizationError::UnsupportedScale)?;
    if representation_decimals >= source_decimals {
        if !amount.is_multiple_of(factor) {
            return Err(NormalizationError::Unrepresentable);
        }
        Ok(amount / factor)
    } else {
        amount
            .checked_mul(factor)
            .ok_or(NormalizationError::Overflow)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn downscaling_keeps_residue_attributed_in_source_units() {
        assert_eq!(
            normalize(98_765, 4, 2),
            Ok(Normalized {
                representation_units: 987,
                source_residue: 65
            })
        );
        assert_eq!(
            normalize(99, 4, 2),
            Ok(Normalized {
                representation_units: 0,
                source_residue: 99
            })
        );
    }
    #[test]
    fn source_debits_require_exact_reversible_units() {
        assert_eq!(to_source_exact(100, 2, 4), Ok(1));
        assert_eq!(
            to_source_exact(99, 2, 4),
            Err(NormalizationError::Unrepresentable)
        );
        assert_eq!(to_source_exact(98, 4, 2), Ok(9_800));
        assert_eq!(
            to_source_exact(u128::MAX, 4, 2),
            Err(NormalizationError::Overflow)
        );
    }
    #[test]
    fn upscaling_is_exact_and_rejects_unrepresentable_values() {
        assert_eq!(
            normalize(98, 2, 4),
            Ok(Normalized {
                representation_units: 9_800,
                source_residue: 0
            })
        );
        assert_eq!(
            normalize(u128::MAX, 2, 3),
            Err(NormalizationError::Overflow)
        );
        assert_eq!(
            normalize(1, 0, 39),
            Err(NormalizationError::UnsupportedScale)
        );
        assert_eq!(
            normalize(u128::MAX, 18, 18)
                .expect("same scale")
                .representation_units,
            u128::MAX
        );
    }
}
