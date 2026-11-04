use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

/// Which side of a battle a deposit joins.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    A,
    B,
}

/// A USDC deposit that is waiting for the DEX to return the swapped coin.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingSwap {
    pub battle_id: u64,
    pub side: Side,
    pub beneficiary: AccountId,
    pub token_out: AccountId,
    pub min_token_out: U128,
    pub usdc_in: U128,
    pub from_credit: U128,
}

/// Router configuration, as returned by `get_config`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigView {
    pub arena: AccountId,
    pub dex: AccountId,
    pub usdc: AccountId,
    pub owner: AccountId,
}
