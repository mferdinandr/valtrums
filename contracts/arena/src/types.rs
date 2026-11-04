use near_sdk::{near, AccountId};

/// Seconds-to-nanoseconds helper; NEAR block timestamps are in nanoseconds.
pub const NS_PER_SECOND: u64 = 1_000_000_000;

/// Credit expires 7 days after it was last granted.
pub const CREDIT_TTL_NS: u64 = 7 * 24 * 60 * 60 * NS_PER_SECOND;

/// One of the two tribes in a battle.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    A,
    B,
}

impl Side {
    pub fn opposite(self) -> Self {
        match self {
            Side::A => Side::B,
            Side::B => Side::A,
        }
    }
}

/// Battle lifecycle. Terminal states: `Settled`, `EmergencyHalted`, `Voided`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BattleStatus {
    /// Bond paid, waiting for the agent audit.
    Proposed,
    /// Audit passed, deposits open until the deposit deadline.
    Approved,
    /// Deposits locked, initial prices recorded, timer running.
    Live,
    /// Winner known, foreign-chain execution steps pending.
    Settling,
    Settled,
    EmergencyHalted,
    Voided,
}

impl BattleStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            BattleStatus::Settled | BattleStatus::EmergencyHalted | BattleStatus::Voided
        )
    }
}

/// A battle between two meme tokens. Vault amounts are in each side's own coin units.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Battle {
    pub creator: AccountId,
    pub token_a: AccountId,
    pub token_b: AccountId,
    pub bond: u128,
    pub duration_ns: u64,
    pub deposit_deadline_ns: u64,
    pub status: BattleStatus,
    pub vault_a: u128,
    pub vault_b: u128,
    pub start_time_ns: u64,
    pub end_time_ns: u64,
    pub initial_price_a: Option<u128>,
    pub initial_price_b: Option<u128>,
    pub final_price_a: Option<u128>,
    pub final_price_b: Option<u128>,
    pub winner: Option<Side>,
}

/// A user's stake in one battle.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserPosition {
    pub side: Side,
    /// Amount held in the side's vault, in that coin's units.
    pub coin_amount: u128,
    /// USDC actually spent to create the position (credit plus wallet).
    pub usdc_equiv: u128,
    /// Portion of `usdc_equiv` that was funded from credit.
    pub from_credit: u128,
    pub claimed: bool,
}

/// Per-user balances kept by the arena.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Account {
    pub liquid_balance: u128,
    pub credit_balance: u128,
    pub credit_expires_at_ns: u64,
}

impl Account {
    /// Credit that can still be spent at `now_ns`; expired credit counts as zero.
    pub fn available_credit(&self, now_ns: u64) -> u128 {
        if now_ns < self.credit_expires_at_ns {
            self.credit_balance
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opposite_side() {
        assert_eq!(Side::A.opposite(), Side::B);
        assert_eq!(Side::B.opposite(), Side::A);
    }

    #[test]
    fn terminal_statuses() {
        assert!(BattleStatus::Settled.is_terminal());
        assert!(BattleStatus::EmergencyHalted.is_terminal());
        assert!(BattleStatus::Voided.is_terminal());
        assert!(!BattleStatus::Proposed.is_terminal());
        assert!(!BattleStatus::Approved.is_terminal());
        assert!(!BattleStatus::Live.is_terminal());
        assert!(!BattleStatus::Settling.is_terminal());
    }

    #[test]
    fn credit_within_window_is_available() {
        let account = Account {
            credit_balance: 35,
            credit_expires_at_ns: CREDIT_TTL_NS,
            ..Account::default()
        };
        assert_eq!(
            account.available_credit(3 * 24 * 60 * 60 * NS_PER_SECOND),
            35
        );
    }

    #[test]
    fn expired_credit_counts_as_zero() {
        let account = Account {
            credit_balance: 35,
            credit_expires_at_ns: CREDIT_TTL_NS,
            ..Account::default()
        };
        assert_eq!(
            account.available_credit(8 * 24 * 60 * 60 * NS_PER_SECOND),
            0
        );
    }

    #[test]
    fn new_account_is_empty() {
        let account = Account::default();
        assert_eq!(account.liquid_balance, 0);
        assert_eq!(account.available_credit(0), 0);
    }
}
