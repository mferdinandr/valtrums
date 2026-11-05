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
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    PromiseError, PromiseOrValue,
};

mod events;
mod msgs;

use events::emit;
use msgs::TransferMsg;

/// Gas for the swap on Ref (`ft_transfer_call`, swap, output transfer, resolve).
const REF_SWAP_GAS: Gas = Gas::from_tgas(35);
/// Gas for `on_ref_swap`, which also starts the balance read and its callback.
const ON_REF_SWAP_GAS: Gas = Gas::from_tgas(110);
const BALANCE_GAS: Gas = Gas::from_tgas(10);
/// Gas for `on_measured`, which also starts the payout and its callback.
const ON_MEASURED_GAS: Gas = Gas::from_tgas(95);
/// Gas for the payout `ft_transfer_call`. The receiver runs inside this budget.
const PAYOUT_GAS: Gas = Gas::from_tgas(80);
const ON_PAYOUT_GAS: Gas = Gas::from_tgas(10);
const TRANSFER_GAS: Gas = Gas::from_tgas(15);

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> U128;
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

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
        self.pools
            .insert((token_a.clone(), token_b.clone()), pool_id);
        self.pools
            .insert((token_b.clone(), token_a.clone()), pool_id);
        emit(
            "pool_set",
            json!({ "token_a": token_a, "token_b": token_b, "pool_id": pool_id }),
        );
    }

    /// NEP-141 receiver. A `swap` message starts a swap on Ref; anything else, a
    /// swap without a route, or a swap while another one is running is returned
    /// in full.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token_in = env::predecessor_account_id();
        let Some(TransferMsg::Swap {
            token_out,
            min_amount_out,
            receiver_id,
            receiver_msg,
        }) = msgs::parse_transfer_msg(&msg)
        else {
            return PromiseOrValue::Value(amount);
        };
        let pool = self
            .pools
            .get(&(token_in.clone(), token_out.clone()))
            .copied();
        let Some(pool_id) = pool.filter(|_| amount.0 > 0 && self.inflight.is_none()) else {
            emit(
                "swap_refused",
                json!({ "sender_id": sender_id, "token_in": token_in, "amount": amount }),
            );
            return PromiseOrValue::Value(amount);
        };
        let ref_msg =
            msgs::ref_swap_msg(pool_id, &token_in, &token_out, amount.0, min_amount_out.0);
        emit(
            "swap_started",
            json!({
                "sender_id": sender_id,
                "token_in": token_in,
                "token_out": token_out,
                "amount_in": amount,
                "pool_id": pool_id,
            }),
        );
        self.inflight = Some(Inflight {
            token_in: token_in.clone(),
            token_out,
            amount_in: amount,
            min_out: min_amount_out,
            receiver_id,
            receiver_msg,
            measuring: false,
        });
        ext_ft::ext(token_in)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(REF_SWAP_GAS)
            .ft_transfer_call(self.exchange.clone(), amount, None, ref_msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_REF_SWAP_GAS)
                    .on_ref_swap(),
            )
            .into()
    }

    /// Resolves the swap on Ref. If Ref kept the whole input, the output is
    /// measured next and the input counts as used. If Ref refunded it or the call
    /// failed, the unused input is handed back to the original sender.
    #[private]
    pub fn on_ref_swap(&mut self, #[callback_result] result: Result<U128, PromiseError>) -> U128 {
        let Some(mut swap) = self.inflight.clone() else {
            return U128(0);
        };
        let used = result.map_or(0, |used| used.0).min(swap.amount_in.0);
        let unused = swap.amount_in.0 - used;
        if unused > 0 {
            self.inflight = None;
            emit(
                "swap_failed",
                json!({ "token_in": swap.token_in, "returned": U128(unused) }),
            );
            return U128(unused);
        }
        swap.measuring = true;
        self.inflight = Some(swap.clone());
        let _ = self.request_balance(&swap);
        U128(0)
    }

    /// Reads the output balance again after a failed measurement. Anyone can call it.
    pub fn retry_measure(&mut self) {
        let swap = self.inflight.clone();
        require!(
            swap.as_ref().is_some_and(|s| s.measuring),
            "No swap is waiting for a measurement"
        );
        if let Some(swap) = swap {
            let _ = self.request_balance(&swap);
        }
    }

    /// Books the measured output and pays it to the receiver.
    #[private]
    pub fn on_measured(&mut self, #[callback_result] balance: Result<U128, PromiseError>) {
        let Some(swap) = self.inflight.clone().filter(|s| s.measuring) else {
            return;
        };
        let Ok(after) = balance else {
            emit("measure_failed", json!({ "token_out": swap.token_out }));
            return;
        };
        let before = self.held_of(&swap.token_out);
        let delta = after.0.saturating_sub(before);
        self.inflight = None;
        if delta == 0 || delta < swap.min_out.0 {
            self.held.insert(swap.token_out.clone(), after.0);
            emit(
                "output_short",
                json!({ "token_out": swap.token_out, "measured": U128(delta) }),
            );
            return;
        }
        self.held.insert(swap.token_out.clone(), after.0 - delta);
        emit(
            "swap_completed",
            json!({
                "token_in": swap.token_in,
                "amount_in": swap.amount_in,
                "token_out": swap.token_out,
                "amount_out": U128(delta),
                "receiver_id": swap.receiver_id,
            }),
        );
        let _ = ext_ft::ext(swap.token_out.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(PAYOUT_GAS)
            .ft_transfer_call(swap.receiver_id, U128(delta), None, swap.receiver_msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_PAYOUT_GAS)
                    .on_payout(swap.token_out, U128(delta)),
            );
    }

    /// Keeps whatever the receiver handed back so the owner can recover it.
    #[private]
    pub fn on_payout(
        &mut self,
        token_out: AccountId,
        amount: U128,
        #[callback_result] result: Result<U128, PromiseError>,
    ) {
        let unused = match result {
            Ok(used) => amount.0.saturating_sub(used.0),
            Err(_) => amount.0,
        };
        if unused > 0 {
            let held = self.held_of(&token_out);
            self.held
                .insert(token_out.clone(), held.saturating_add(unused));
        }
        emit(
            "payout_resolved",
            json!({ "token_out": token_out, "unused": U128(unused) }),
        );
    }

    /// Sends output coin the adapter kept (refused payouts) to `to`.
    #[payable]
    pub fn withdraw_held(&mut self, token: AccountId, to: AccountId, amount: U128) {
        self.assert_owner();
        near_sdk::assert_one_yocto();
        let held = self.held_of(&token);
        require!(
            amount.0 > 0 && amount.0 <= held,
            "Amount exceeds the held balance"
        );
        self.held.insert(token.clone(), held - amount.0);
        let _ = ext_ft::ext(token)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(TRANSFER_GAS)
            .ft_transfer(to, amount, None);
    }

    /// Drops a stuck swap record. Use only when the swap can no longer finish.
    pub fn clear_inflight(&mut self) {
        self.assert_owner();
        self.inflight = None;
        emit("inflight_cleared", json!({}));
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

    /// Reads this contract's balance of the output coin, then books it.
    fn request_balance(&self, swap: &Inflight) -> near_sdk::Promise {
        ext_ft::ext(swap.token_out.clone())
            .with_static_gas(BALANCE_GAS)
            .ft_balance_of(env::current_account_id())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_MEASURED_GAS)
                    .on_measured(),
            )
    }
}

#[cfg(test)]
mod tests;
