//! Pure helpers for the messages the router receives and sends.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{near, AccountId};

use crate::types::{PendingSwap, Side};

/// Fields of a `swap_deposit` request.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapDeposit {
    pub battle_id: u64,
    pub side: Side,
    pub beneficiary: AccountId,
    pub token_out: AccountId,
    pub min_token_out: U128,
    pub from_credit: U128,
}

/// Messages the arena sends together with the USDC.
#[near(serializers = [json])]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ArenaMsg {
    SwapDeposit(SwapDeposit),
}

/// Receipt the DEX attaches to the swapped coin.
#[near(serializers = [json])]
pub struct SwapReceipt {
    pub swap_id: u64,
}

pub fn parse_arena_msg(msg: &str) -> Option<ArenaMsg> {
    serde_json::from_str(msg).ok()
}

pub fn parse_swap_receipt(msg: &str) -> Option<SwapReceipt> {
    serde_json::from_str(msg).ok()
}

/// Message for the DEX `ft_transfer_call` (step 3).
pub fn dex_swap_msg(pending: &PendingSwap, swap_id: u64, router: &AccountId) -> String {
    json!({
        "action": "swap",
        "token_out": pending.token_out,
        "min_amount_out": pending.min_token_out,
        "receiver_id": router,
        "receiver_msg": json!({ "swap_id": swap_id }).to_string(),
    })
    .to_string()
}

/// Message for the arena `ft_transfer_call` (step 5).
pub fn arena_deposit_msg(pending: &PendingSwap) -> String {
    json!({
        "action": "deposit",
        "battle_id": pending.battle_id,
        "side": pending.side,
        "beneficiary": pending.beneficiary,
        "usdc_equiv": pending.usdc_in,
        "from_credit": pending.from_credit,
    })
    .to_string()
}

/// Amount left over after an `ft_transfer_call` resolved. The call resolves to
/// the amount the receiver used; a failed call used nothing. Any shortfall is
/// treated as failure of the whole hop, so the result is what must be handed back.
pub fn unused_after_transfer(sent: u128, used: Option<u128>) -> u128 {
    match used {
        Some(used) => sent.saturating_sub(used),
        None => sent,
    }
}
