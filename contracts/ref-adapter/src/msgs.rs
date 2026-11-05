//! Messages the adapter receives from callers and sends to Ref.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{near, AccountId};

/// Swap request, identical to the one the mock DEX accepts.
#[near(serializers = [json])]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum TransferMsg {
    Swap {
        token_out: AccountId,
        min_amount_out: U128,
        receiver_id: AccountId,
        receiver_msg: String,
    },
}

pub fn parse_transfer_msg(msg: &str) -> Option<TransferMsg> {
    serde_json::from_str(msg).ok()
}

/// Message for the `ft_transfer_call` that makes Ref run a one-step swap.
/// Ref refuses a zero minimum, so the floor is at least one unit.
pub fn ref_swap_msg(
    pool_id: u64,
    token_in: &AccountId,
    token_out: &AccountId,
    amount_in: u128,
    min_out: u128,
) -> String {
    json!({
        "force": 0,
        "actions": [{
            "pool_id": pool_id,
            "token_in": token_in,
            "token_out": token_out,
            "amount_in": amount_in.to_string(),
            "min_amount_out": min_out.max(1).to_string(),
        }],
    })
    .to_string()
}
