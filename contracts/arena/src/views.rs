use crate::types::{Battle, BattleStatus, SettlementStep, Side, StepKind, UserPosition};
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
    /// Contract allowed to deliver swapped deposits; `None` disables USDC deposits.
    pub router: Option<AccountId>,
    /// DEX the arena swaps through when it executes settlement steps itself.
    pub execution_dex: Option<AccountId>,
    /// Account that receives burned coins.
    pub burn_account: Option<AccountId>,
    pub paused: bool,
    pub treasury_accrued: U128,
}

/// A battle as exposed to clients. 128/64-bit values are JSON strings.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BattleView {
    pub id: u64,
    pub creator: AccountId,
    pub token_a: AccountId,
    pub token_b: AccountId,
    pub bond: U128,
    pub duration_ns: U64,
    pub deposit_deadline_ns: U64,
    pub status: BattleStatus,
    pub vault_a: U128,
    pub vault_b: U128,
    pub start_time_ns: U64,
    pub end_time_ns: U64,
    pub initial_price_a: Option<U128>,
    pub initial_price_b: Option<U128>,
    pub final_price_a: Option<U128>,
    pub final_price_b: Option<U128>,
    pub winner: Option<Side>,
}

impl BattleView {
    pub fn new(id: u64, battle: &Battle) -> Self {
        Self {
            id,
            creator: battle.creator.clone(),
            token_a: battle.token_a.clone(),
            token_b: battle.token_b.clone(),
            bond: U128(battle.bond),
            duration_ns: U64(battle.duration_ns),
            deposit_deadline_ns: U64(battle.deposit_deadline_ns),
            status: battle.status,
            vault_a: U128(battle.vault_a),
            vault_b: U128(battle.vault_b),
            start_time_ns: U64(battle.start_time_ns),
            end_time_ns: U64(battle.end_time_ns),
            initial_price_a: battle.initial_price_a.map(U128),
            initial_price_b: battle.initial_price_b.map(U128),
            final_price_a: battle.final_price_a.map(U128),
            final_price_b: battle.final_price_b.map(U128),
            winner: battle.winner,
        }
    }
}

/// A user's stake in one battle.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PositionView {
    pub side: Side,
    pub coin_amount: U128,
    pub usdc_equiv: U128,
    pub from_credit: U128,
    pub claimed: bool,
}

impl PositionView {
    pub fn new(position: &UserPosition) -> Self {
        Self {
            side: position.side,
            coin_amount: U128(position.coin_amount),
            usdc_equiv: U128(position.usdc_equiv),
            from_credit: U128(position.from_credit),
            claimed: position.claimed,
        }
    }
}

/// A user's arena balances. `credit_balance` only counts credit that is still valid.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountView {
    pub credit_balance: U128,
    pub credit_expires_at_ns: U64,
}

/// How a USDC deposit of a given size would be funded right now.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FundingPreview {
    pub from_credit: U128,
    pub from_wallet: U128,
}

/// One settlement step as exposed to clients.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementStepView {
    pub index: u32,
    pub kind: StepKind,
    pub amount: U128,
    pub done: bool,
    /// Sent to the DEX and waiting for its proceeds.
    pub dispatched: bool,
    pub realized: Option<U128>,
}

impl SettlementStepView {
    pub fn new(index: usize, step: &SettlementStep) -> Self {
        Self {
            index: index as u32,
            kind: step.kind,
            amount: U128(step.amount),
            done: step.done,
            dispatched: step.min_out.is_some() && !step.done,
            realized: step.done.then_some(U128(step.realized)),
        }
    }
}
