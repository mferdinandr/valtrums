//! Adapter between the router/arena swap protocol and the Ref Finance v1 exchange.
//!
//! Callers send the coin to swap with a `swap` message through `ft_transfer_call`
//! (the same message the testnet mock DEX accepts). The adapter forwards the swap to
//! Ref, measures the output coin by balance delta against its own ledger, enforces
//! the caller's minimum, and pays the receiver with `ft_transfer_call`.
//!
//! Ref pays the swap output with a plain `ft_transfer` and never calls the sender
//! back, so the amount cannot come from a message; it has to be measured.
//! One swap is in flight at a time. A second request is refused and refunded.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

mod events;
mod msgs;

use events::emit;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Pools,
    Held,
}

/// The swap currently being executed on Ref.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Inflight {
    pub token_in: AccountId,
    pub token_out: AccountId,
    pub amount_in: U128,
    pub min_out: U128,
    pub receiver_id: AccountId,
    pub receiver_msg: String,
    /// True once Ref has taken the whole input and only the measurement is left.
    pub measuring: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct RefAdapter {
    owner: AccountId,
    exchange: AccountId,
    /// Ref pool used for each ordered pair `(token_in, token_out)`.
    pools: LookupMap<(AccountId, AccountId), u64>,
    /// Output coin the adapter holds outside any swap: leftovers of refused payouts.
    held: LookupMap<AccountId, u128>,
    inflight: Option<Inflight>,
}

#[near]
impl RefAdapter {
    #[init]
    pub fn new(owner: AccountId, exchange: AccountId) -> Self {
        Self {
            owner,
            exchange,
            pools: LookupMap::new(StorageKey::Pools),
            held: LookupMap::new(StorageKey::Held),
            inflight: None,
        }
    }

    pub fn set_exchange(&mut self, exchange: AccountId) {
        self.assert_owner();
        require!(self.inflight.is_none(), "A swap is in flight");
        self.exchange = exchange;
    }

    /// Routes the pair through a Ref pool, in both directions.
    pub fn set_pool(&mut self, token_a: AccountId, token_b: AccountId, pool_id: u64) {
        self.assert_owner();
        require!(token_a != token_b, "Tokens must differ");
        self.pools.insert((token_a.clone(), token_b.clone()), pool_id);
        self.pools.insert((token_b.clone(), token_a.clone()), pool_id);
        emit(
            "pool_set",
            json!({ "token_a": token_a, "token_b": token_b, "pool_id": pool_id }),
        );
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_exchange(&self) -> AccountId {
        self.exchange.clone()
    }

    pub fn get_pool(&self, token_in: AccountId, token_out: AccountId) -> Option<u64> {
        self.pools.get(&(token_in, token_out)).copied()
    }

    pub fn get_inflight(&self) -> Option<Inflight> {
        self.inflight.clone()
    }

    pub fn get_held(&self, token: AccountId) -> U128 {
        U128(self.held_of(&token))
    }
}

impl RefAdapter {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Only the owner can call this method"
        );
    }

    fn held_of(&self, token: &AccountId) -> u128 {
        self.held.get(token).copied().unwrap_or(0)
    }
}

#[cfg(test)]
mod tests;
