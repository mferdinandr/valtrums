use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

/// Contract configuration as exposed to clients.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigView {
    pub owner: AccountId,
    pub usdc: AccountId,
    pub treasury: AccountId,
    pub bond: U128,
    pub deposit_window_secs: U64,
    pub agents: Vec<AccountId>,
    pub paused: bool,
    pub treasury_accrued: U128,
}
