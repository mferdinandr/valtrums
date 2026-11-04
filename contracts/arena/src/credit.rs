use crate::types::Account;

/// How a USDC deposit is funded: locked credit first, the remainder from the wallet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FundingPlan {
    pub from_credit: u128,
    pub from_wallet: u128,
}

impl FundingPlan {
    pub fn total(&self) -> u128 {
        self.from_credit + self.from_wallet
    }
}

/// Credit is consumed first; only what it cannot cover comes from the wallet.
pub fn plan_funding(available_credit: u128, total: u128) -> FundingPlan {
    let from_credit = available_credit.min(total);
    FundingPlan {
        from_credit,
        from_wallet: total - from_credit,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreditError {
    /// More credit requested than is currently spendable.
    Insufficient,
}

impl Account {
    /// Zeroes the credit balance once its expiry has passed.
    pub fn sweep_expired(&mut self, now_ns: u64) {
        if now_ns >= self.credit_expires_at_ns {
            self.credit_balance = 0;
            self.credit_expires_at_ns = 0;
        }
    }

    /// Spends `amount` of valid credit. Expired credit cannot be spent.
    pub fn consume_credit(&mut self, now_ns: u64, amount: u128) -> Result<(), CreditError> {
        if amount > self.available_credit(now_ns) {
            return Err(CreditError::Insufficient);
        }
        self.credit_balance -= amount;
        if self.credit_balance == 0 {
            self.credit_expires_at_ns = 0;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CREDIT_TTL_NS, NS_PER_SECOND};

    const DAY_NS: u64 = 24 * 60 * 60 * NS_PER_SECOND;

    fn account_with_credit(amount: u128) -> Account {
        Account {
            credit_balance: amount,
            credit_expires_at_ns: CREDIT_TTL_NS,
            ..Account::default()
        }
    }

    #[test]
    fn prd_example_50_is_35_credit_plus_15_wallet() {
        let plan = plan_funding(35, 50);
        assert_eq!(plan.from_credit, 35);
        assert_eq!(plan.from_wallet, 15);
        assert_eq!(plan.total(), 50);
    }

    #[test]
    fn credit_covering_everything_needs_no_wallet() {
        let plan = plan_funding(60, 50);
        assert_eq!(plan.from_credit, 50);
        assert_eq!(plan.from_wallet, 0);
    }

    #[test]
    fn no_credit_means_all_wallet() {
        let plan = plan_funding(0, 50);
        assert_eq!(plan.from_credit, 0);
        assert_eq!(plan.from_wallet, 50);
    }

    #[test]
    fn plan_always_sums_to_total() {
        for credit in [0u128, 1, 34, 35, 36, 1_000] {
            for total in [0u128, 1, 49, 50, 51, 2_000] {
                assert_eq!(plan_funding(credit, total).total(), total);
            }
        }
    }

    #[test]
    fn consuming_credit_reduces_the_balance() {
        let mut account = account_with_credit(35);
        account.consume_credit(3 * DAY_NS, 20).unwrap();
        assert_eq!(account.credit_balance, 15);
        assert_eq!(account.credit_expires_at_ns, CREDIT_TTL_NS);
    }

    #[test]
    fn consuming_all_credit_clears_the_expiry() {
        let mut account = account_with_credit(35);
        account.consume_credit(DAY_NS, 35).unwrap();
        assert_eq!(account.credit_balance, 0);
        assert_eq!(account.credit_expires_at_ns, 0);
    }

    #[test]
    fn cannot_consume_more_than_available() {
        let mut account = account_with_credit(35);
        assert_eq!(
            account.consume_credit(DAY_NS, 36),
            Err(CreditError::Insufficient)
        );
        assert_eq!(account.credit_balance, 35);
    }

    #[test]
    fn expired_credit_cannot_be_consumed() {
        let mut account = account_with_credit(35);
        assert_eq!(
            account.consume_credit(8 * DAY_NS, 1),
            Err(CreditError::Insufficient)
        );
    }

    #[test]
    fn expiry_boundary_is_exclusive() {
        let mut account = account_with_credit(35);
        assert!(account.consume_credit(CREDIT_TTL_NS - 1, 1).is_ok());
        assert_eq!(
            account.consume_credit(CREDIT_TTL_NS, 1),
            Err(CreditError::Insufficient)
        );
    }

    #[test]
    fn sweep_removes_only_expired_credit() {
        let mut account = account_with_credit(35);
        account.sweep_expired(DAY_NS);
        assert_eq!(account.credit_balance, 35);

        account.sweep_expired(8 * DAY_NS);
        assert_eq!(account.credit_balance, 0);
        assert_eq!(account.credit_expires_at_ns, 0);
    }
}
