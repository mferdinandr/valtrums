//! On-chain audit evaluation (docs/goplus-audit.md).
//!
//! The agent normalizes the raw GoPlus response into `GoPlusEvidence`; the
//! arena evaluates it with the decision precedence: Reject over Pending over
//! Pass, and the independent strict LP gate. Tax/admin thresholds and
//! evidence freshness stay OPEN; without an explicit resolution, the required
//! checks keep approval Pending instead of inventing a threshold.

pub use crate::types::AuditDecision;
use crate::types::{GoPlusEvidence, LpEvidence, TriState};

/// USD 10,000 scaled by 1e6. The LP gate is strictly greater than this.
pub const LP_MIN_SCALED: u128 = 10_000 * 1_000_000;
/// Tax fraction of exactly 1 (100%) scaled by 1e6 rejects the path.
pub const TAX_ONE_SCALED: u64 = 1_000_000;

/// Normalizes a GoPlus string flag: "1" is true, "0" is false, anything else
/// (missing, null, unexpected) is Unknown. No truthiness coercion.
pub fn normalize_flag(value: Option<&str>) -> TriState {
    match value {
        Some("1") => TriState::True,
        Some("0") => TriState::False,
        _ => TriState::Unknown,
    }
}

/// Parses an exact decimal tax fraction (e.g. "0.05" -> 50_000 at 1e6 scale).
/// Malformed or empty stays Unknown (None). Never binary floating point.
pub fn parse_tax_fraction(value: Option<&str>) -> Option<u64> {
    let text = value?;
    if text.is_empty() {
        return None;
    }
    let (whole, frac) = match text.split_once('.') {
        Some((w, f)) => (w, f),
        None => (text, ""),
    };
    let whole: u64 = whole.parse().ok()?;
    let mut frac_scaled: u64 = if frac.is_empty() {
        0
    } else {
        frac.parse().ok()?
    };
    let digits = frac.len() as u32;
    if digits > 6 {
        return None; // malformed: finer than policy precision is Unknown
    }
    for _ in digits..6 {
        frac_scaled = frac_scaled.checked_mul(10)?;
    }
    whole.checked_mul(1_000_000)?.checked_add(frac_scaled)
}

/// Evaluates a community's audit evidence. `now_ns`/`ttl_ns` implement the
/// versioned freshness policy; TTL is OPEN and passed by the caller.
pub fn evaluate_audit(
    goplus: &GoPlusEvidence,
    lp: &LpEvidence,
    now_ns: u64,
    ttl_ns: u64,
) -> AuditDecision {
    // Stale evidence can never pass or reject; it holds Pending.
    if now_ns.saturating_sub(goplus.queried_at_ns.0) > ttl_ns
        || now_ns.saturating_sub(lp.observed_at_ns.0) > ttl_ns
    {
        return AuditDecision::Pending;
    }

    // Reject first: an established critical finding is not hidden by a
    // simultaneous missing field (Reject-over-Pending precedence).
    if goplus.is_honeypot == TriState::True
        || goplus.cannot_sell_all == TriState::True
        || goplus.cannot_buy == TriState::True
        || goplus.buy_tax == Some(TAX_ONE_SCALED)
        || goplus.sell_tax == Some(TAX_ONE_SCALED)
        || goplus.transfer_tax == Some(TAX_ONE_SCALED)
    {
        return AuditDecision::Reject;
    }

    // Independent strict LP gate: must be strictly above USD 10,000.
    if lp.usd_value_scaled.0 <= LP_MIN_SCALED {
        return AuditDecision::Pending;
    }

    // Unknown mandatory data holds Pending.
    if goplus.is_honeypot == TriState::Unknown
        || goplus.cannot_sell_all == TriState::Unknown
        || goplus.cannot_buy == TriState::Unknown
        || goplus.buy_tax.is_none()
        || goplus.sell_tax.is_none()
        || goplus.transfer_tax.is_none()
    {
        return AuditDecision::Pending;
    }

    // Unresolved required policy or incomplete coverage stays Pending.
    let has_tax = goplus.buy_tax.unwrap_or(0) > 0
        || goplus.sell_tax.unwrap_or(0) > 0
        || goplus.transfer_tax.unwrap_or(0) > 0;
    if has_tax && !goplus.tax_policy_resolved {
        return AuditDecision::Pending;
    }
    if !goplus.coverage_complete {
        return AuditDecision::Pending;
    }

    AuditDecision::Pass
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::json_types::U64;
    use crate::types::{AuditEvidence, LpEvidence};

    const TTL: u64 = 60 * 60 * 1_000_000_000;

    fn goplus(
        honeypot: TriState,
        sell: TriState,
        buy: TriState,
        tax: Option<u64>,
    ) -> GoPlusEvidence {
        GoPlusEvidence {
            chain_id: 46630,
            token_address: "0xabc".to_string(),
            provider_version: "v1".to_string(),
            policy_version: 1,
            queried_at_ns: U64(1_000),
            is_honeypot: honeypot,
            cannot_sell_all: sell,
            cannot_buy: buy,
            buy_tax: tax,
            sell_tax: tax,
            transfer_tax: Some(0),
            coverage_complete: true,
            tax_policy_resolved: false,
            evidence_hash: "h".to_string(),
        }
    }

    fn lp(value: u128) -> LpEvidence {
        LpEvidence {
            usd_value_scaled: near_sdk::json_types::U128(value),
            source: "fixture".to_string(),
            observed_at_ns: U64(1_000),
            evidence_hash: "h".to_string(),
        }
    }

    fn eval(g: &GoPlusEvidence, lp: &LpEvidence) -> AuditDecision {
        evaluate_audit(g, lp, 2_000, TTL)
    }

    fn audit_for(g: &GoPlusEvidence, lp: &LpEvidence) -> AuditEvidence {
        AuditEvidence {
            decision: eval(g, lp),
            goplus: g.clone(),
            lp: lp.clone(),
        }
    }

    #[test]
    fn clean_evidence_with_large_lp_passes() {
        // Zero-tax path: policy resolution is not needed because no tax is
        // present, so it passes.
        let g = goplus(TriState::False, TriState::False, TriState::False, Some(0));
        assert_eq!(eval(&g, &lp(10_001 * 1_000_000)), AuditDecision::Pass);
    }

    #[test]
    fn critical_honeypot_rejects_even_with_missing_fields() {
        let g = GoPlusEvidence {
            is_honeypot: TriState::True,
            buy_tax: None,
            sell_tax: None,
            transfer_tax: None,
            ..goplus(TriState::True, TriState::False, TriState::False, None)
        };
        assert_eq!(eval(&g, &lp(50_000 * 1_000_000)), AuditDecision::Reject);
    }

    #[test]
    fn cannot_sell_all_rejects() {
        let g = goplus(TriState::False, TriState::True, TriState::False, None);
        assert_eq!(eval(&g, &lp(50_000 * 1_000_000)), AuditDecision::Reject);
    }

    #[test]
    fn lp_equality_and_below_hold_pending() {
        let g = goplus(TriState::False, TriState::False, TriState::False, Some(0));
        assert_eq!(eval(&g, &lp(10_000 * 1_000_000)), AuditDecision::Pending);
        assert_eq!(eval(&g, &lp(9_999 * 1_000_000)), AuditDecision::Pending);
        assert_eq!(eval(&g, &lp(10_001 * 1_000_000)), AuditDecision::Pass);
    }

    #[test]
    fn missing_lp_evidence_holds_pending() {
        let g = goplus(TriState::False, TriState::False, TriState::False, Some(0));
        assert_eq!(eval(&g, &lp(0)), AuditDecision::Pending);
    }

    #[test]
    fn unknown_mandatory_field_holds_pending() {
        let g = goplus(TriState::Unknown, TriState::False, TriState::False, None);
        assert_eq!(eval(&g, &lp(50_000 * 1_000_000)), AuditDecision::Pending);
    }

    #[test]
    fn tax_of_one_rejects() {
        let g = goplus(TriState::False, TriState::False, TriState::False, Some(1_000_000));
        assert_eq!(eval(&g, &lp(50_000 * 1_000_000)), AuditDecision::Reject);
    }

    #[test]
    fn nonzero_tax_holds_pending_until_policy_resolved() {
        let g = goplus(TriState::False, TriState::False, TriState::False, Some(50_000));
        assert_eq!(eval(&g, &lp(50_000 * 1_000_000)), AuditDecision::Pending);
        let resolved = GoPlusEvidence {
            tax_policy_resolved: true,
            ..goplus(TriState::False, TriState::False, TriState::False, Some(50_000))
        };
        assert_eq!(eval(&resolved, &lp(50_000 * 1_000_000)), AuditDecision::Pass);
    }

    #[test]
    fn stale_evidence_holds_pending() {
        let g = goplus(TriState::False, TriState::False, TriState::False, Some(0));
        assert_eq!(evaluate_audit(&g, &lp(50_000 * 1_000_000), 1_000 + TTL + 1, TTL), AuditDecision::Pending);
    }

    #[test]
    fn flag_normalization_is_explicit() {
        assert_eq!(normalize_flag(Some("1")), TriState::True);
        assert_eq!(normalize_flag(Some("0")), TriState::False);
        assert_eq!(normalize_flag(None), TriState::Unknown);
        assert_eq!(normalize_flag(Some("true")), TriState::Unknown);
    }

    #[test]
    fn tax_fraction_parses_exactly() {
        assert_eq!(parse_tax_fraction(Some("0.05")), Some(50_000));
        assert_eq!(parse_tax_fraction(Some("1")), Some(1_000_000));
        assert_eq!(parse_tax_fraction(Some("0")), Some(0));
        assert_eq!(parse_tax_fraction(None), None);
        assert_eq!(parse_tax_fraction(Some("")), None);
        assert_eq!(parse_tax_fraction(Some("abc")), None);
        assert_eq!(parse_tax_fraction(Some("0.0000001")), None);
    }

    #[test]
    fn audit_view_bundles_decision() {
        let g = goplus(TriState::False, TriState::False, TriState::False, Some(0));
        let evidence = audit_for(&g, &lp(10_001 * 1_000_000));
        assert_eq!(evidence.decision, AuditDecision::Pass);
    }
}