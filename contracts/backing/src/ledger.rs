//! Checked accounting for one representation asset, in representation units.
//! These transitions do not verify source-chain evidence or authorize callers.

use near_sdk::near;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Ledger {
    pub custody: u128,
    pub minted: u128,
    pub entitlements: u128,
    pub payouts: u128,
    pub disposal: u128,
    pub unallocated: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LedgerError {
    ZeroAmount,
    InsufficientLiability,
    Overflow,
    InvariantViolation,
}

#[derive(Clone, Copy)]
pub enum Bucket {
    Minted,
    Entitlements,
    Payouts,
    Disposal,
    Unallocated,
}

impl Ledger {
    pub fn is_balanced(&self) -> bool {
        self.minted
            .checked_add(self.entitlements)
            .and_then(|v| v.checked_add(self.payouts))
            .and_then(|v| v.checked_add(self.disposal))
            .and_then(|v| v.checked_add(self.unallocated))
            == Some(self.custody)
    }

    fn bucket(&mut self, bucket: Bucket) -> &mut u128 {
        match bucket {
            Bucket::Minted => &mut self.minted,
            Bucket::Entitlements => &mut self.entitlements,
            Bucket::Payouts => &mut self.payouts,
            Bucket::Disposal => &mut self.disposal,
            Bucket::Unallocated => &mut self.unallocated,
        }
    }

    /// Record a verified, finalized actual receipt. Verification is external.
    pub fn add_receipt(&mut self, amount: u128) -> Result<(), LedgerError> {
        if amount == 0 {
            return Err(LedgerError::ZeroAmount);
        }
        let mut next = self.clone();
        next.custody = next
            .custody
            .checked_add(amount)
            .ok_or(LedgerError::Overflow)?;
        next.unallocated = next
            .unallocated
            .checked_add(amount)
            .ok_or(LedgerError::Overflow)?;
        next.commit_to(self)
    }

    /// Move the same backing between two exclusive liabilities.
    pub fn move_liability(
        &mut self,
        from: Bucket,
        to: Bucket,
        amount: u128,
    ) -> Result<(), LedgerError> {
        if amount == 0 {
            return Err(LedgerError::ZeroAmount);
        }
        let mut next = self.clone();
        let source = next.bucket(from);
        *source = source
            .checked_sub(amount)
            .ok_or(LedgerError::InsufficientLiability)?;
        let destination = next.bucket(to);
        *destination = destination
            .checked_add(amount)
            .ok_or(LedgerError::Overflow)?;
        next.commit_to(self)
    }

    /// Consume a previously reserved payout or disposal after verified final debit.
    pub fn confirm_debit(&mut self, reservation: Bucket, amount: u128) -> Result<(), LedgerError> {
        if !matches!(reservation, Bucket::Payouts | Bucket::Disposal) {
            return Err(LedgerError::InvariantViolation);
        }
        if amount == 0 {
            return Err(LedgerError::ZeroAmount);
        }
        let mut next = self.clone();
        let reserved = next.bucket(reservation);
        *reserved = reserved
            .checked_sub(amount)
            .ok_or(LedgerError::InsufficientLiability)?;
        next.custody = next
            .custody
            .checked_sub(amount)
            .ok_or(LedgerError::InsufficientLiability)?;
        next.commit_to(self)
    }

    fn commit_to(self, target: &mut Self) -> Result<(), LedgerError> {
        if !self.is_balanced() {
            return Err(LedgerError::InvariantViolation);
        }
        *target = self;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn liabilities_conserve_custody_across_exclusive_reservations() {
        let mut ledger = Ledger::default();
        ledger.add_receipt(98).expect("receipt");
        ledger
            .move_liability(Bucket::Unallocated, Bucket::Minted, 98)
            .expect("mint");
        ledger
            .move_liability(Bucket::Minted, Bucket::Payouts, 60)
            .expect("reserve redemption");
        assert_eq!(
            ledger.move_liability(Bucket::Minted, Bucket::Disposal, 60),
            Err(LedgerError::InsufficientLiability)
        );
        ledger
            .move_liability(Bucket::Minted, Bucket::Disposal, 38)
            .expect("reserve disposal");
        ledger
            .confirm_debit(Bucket::Payouts, 60)
            .expect("confirm payout");
        assert_eq!(ledger.custody, 38);
        assert_eq!(ledger.disposal, 38);
        assert!(ledger.is_balanced());
    }
    #[test]
    fn failed_or_overflowing_transition_leaves_state_unchanged() {
        let mut ledger = Ledger::default();
        ledger.add_receipt(u128::MAX).expect("receipt");
        let original = ledger.clone();
        assert_eq!(ledger.add_receipt(1), Err(LedgerError::Overflow));
        assert_eq!(
            ledger.move_liability(Bucket::Minted, Bucket::Payouts, 1),
            Err(LedgerError::InsufficientLiability)
        );
        assert_eq!(
            ledger.confirm_debit(Bucket::Unallocated, 1),
            Err(LedgerError::InvariantViolation)
        );
        assert_eq!(ledger, original);
    }

    #[test]
    fn partial_entitlement_payout_and_disposal_conserve_each_bucket() {
        let mut ledger = Ledger::default();
        ledger.add_receipt(1_000).expect("receipt");
        ledger
            .move_liability(Bucket::Unallocated, Bucket::Minted, 900)
            .expect("mint");
        ledger
            .move_liability(Bucket::Minted, Bucket::Entitlements, 500)
            .expect("allocation");
        ledger
            .move_liability(Bucket::Entitlements, Bucket::Payouts, 300)
            .expect("payout reservation");
        ledger
            .move_liability(Bucket::Minted, Bucket::Disposal, 100)
            .expect("disposal reservation");
        assert_eq!(
            (
                ledger.custody,
                ledger.minted,
                ledger.entitlements,
                ledger.payouts,
                ledger.disposal,
                ledger.unallocated
            ),
            (1000, 300, 200, 300, 100, 100)
        );
        assert!(ledger.is_balanced());
        ledger
            .confirm_debit(Bucket::Payouts, 125)
            .expect("partial confirmation");
        assert_eq!((ledger.custody, ledger.payouts), (875, 175));
        assert!(ledger.is_balanced());
        ledger
            .confirm_debit(Bucket::Disposal, 100)
            .expect("disposal confirmation");
        assert_eq!((ledger.custody, ledger.disposal), (775, 0));
        assert!(ledger.is_balanced());
    }
}
