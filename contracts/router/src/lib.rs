//! Swap router: turns a USDC deposit into the side's meme coin through a DEX
//! and deposits the coin into the arena. The router never keeps user funds:
//! every hop either fully succeeds or hands the amount back to the sender.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

pub mod events;
pub mod msgs;
pub mod types;

use msgs::{ArenaMsg, SwapDeposit};
use types::{ConfigView, PendingSwap};

/// Gas for the USDC `ft_transfer_call` to the DEX. The DEX runs inside it.
const DEX_TRANSFER_GAS: Gas = Gas::from_tgas(120);
/// Gas for the coin `ft_transfer_call` to the arena. The arena runs inside it.
const ARENA_TRANSFER_GAS: Gas = Gas::from_tgas(50);
const CALLBACK_GAS: Gas = Gas::from_tgas(15);
/// Gas for paying out stranded coin.
const CLAIM_TRANSFER_GAS: Gas = Gas::from_tgas(15);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Pending,
    Stranded,
}

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
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Router {
    owner: AccountId,
    arena: AccountId,
    dex: AccountId,
    usdc: AccountId,
    next_swap_id: u64,
    pending: LookupMap<u64, PendingSwap>,
    /// Coin owed to a beneficiary after the arena refused a deposit, keyed by
    /// (beneficiary, token).
    stranded: LookupMap<(AccountId, AccountId), u128>,
}

#[near]
impl Router {
    #[init]
    pub fn new(owner: AccountId, arena: AccountId, dex: AccountId, usdc: AccountId) -> Self {
        Self {
            owner,
            arena,
            dex,
            usdc,
            next_swap_id: 0,
            pending: LookupMap::new(StorageKey::Pending),
            stranded: LookupMap::new(StorageKey::Stranded),
        }
    }

    // ─── Owner configuration ────────────────────────────────────────────

    pub fn set_arena(&mut self, arena: AccountId) {
        self.assert_owner();
        self.arena = arena;
    }

    pub fn set_dex(&mut self, dex: AccountId) {
        self.assert_owner();
        self.dex = dex;
    }

    /// Pays the caller's stranded balance of `token`. The balance is cleared
    /// before the transfer and restored if the transfer fails.
    #[payable]
    pub fn claim_stranded(&mut self, token: AccountId) -> Promise {
        near_sdk::assert_one_yocto();
        let account = env::predecessor_account_id();
        let key = (account.clone(), token.clone());
        let amount = self.stranded.get(&key).copied().unwrap_or(0);
        require!(amount > 0, "Nothing stranded for this token");
        self.stranded.remove(&key);
        ext_ft::ext(token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(CLAIM_TRANSFER_GAS)
            .ft_transfer(account.clone(), U128(amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_claim_paid(account, token, U128(amount)),
            )
    }

    /// Restores the stranded balance if the payout failed. Never panics.
    #[private]
    pub fn on_claim_paid(
        &mut self,
        account: AccountId,
        token: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            self.add_stranded(&account, &token, amount.0);
            events::emit(
                "claim_failed",
                json!({ "account": account, "token": token, "amount": amount }),
            );
        } else {
            events::emit(
                "stranded_claimed",
                json!({ "account": account, "token": token, "amount": amount }),
            );
        }
    }

    // ─── Token receiver ─────────────────────────────────────────────────

    /// NEP-141 receiver. Returns the unused amount.
    ///
    /// Accepts USDC from the arena with a `swap_deposit` message, and the
    /// swapped coin from the DEX with a `{"swap_id":N}` message. Anything else
    /// is returned in full.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        if token == self.usdc && sender_id == self.arena {
            if let Some(ArenaMsg::SwapDeposit(request)) = msgs::parse_arena_msg(&msg) {
                return self.start_swap(amount.0, request);
            }
        }
        if sender_id == self.dex {
            if let Some(receipt) = msgs::parse_swap_receipt(&msg) {
                return self.finish_swap(token, amount.0, receipt.swap_id);
            }
        }
        PromiseOrValue::Value(amount)
    }

    /// Resolves the USDC hop to the DEX. Returns the unused USDC, which is the
    /// router's own `ft_on_transfer` result for the arena.
    #[private]
    pub fn on_swap_sent(
        &mut self,
        swap_id: u64,
        amount: U128,
        #[callback_result] result: Result<U128, PromiseError>,
    ) -> U128 {
        let used = result.ok().map(|used| used.0);
        let unused = msgs::unused_after_transfer(amount.0, used);
        if unused > 0 {
            self.pending.remove(&swap_id);
            events::emit(
                "swap_failed",
                json!({ "swap_id": swap_id, "returned": U128(unused) }),
            );
        }
        U128(unused)
    }

    /// Resolves the coin hop to the arena. Whatever the arena did not use is
    /// recorded as stranded for the beneficiary. Never panics.
    #[private]
    pub fn on_deposit_sent(
        &mut self,
        beneficiary: AccountId,
        token: AccountId,
        amount: U128,
        #[callback_result] result: Result<U128, PromiseError>,
    ) {
        let used = result.ok().map(|used| used.0);
        let unused = msgs::unused_after_transfer(amount.0, used);
        if unused > 0 {
            self.add_stranded(&beneficiary, &token, unused);
            events::emit(
                "deposit_stranded",
                json!({
                    "beneficiary": beneficiary,
                    "token": token,
                    "amount": U128(unused),
                }),
            );
        }
    }

    // ─── Views ──────────────────────────────────────────────────────────

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            arena: self.arena.clone(),
            dex: self.dex.clone(),
            usdc: self.usdc.clone(),
            owner: self.owner.clone(),
        }
    }

    pub fn get_pending(&self, swap_id: u64) -> Option<PendingSwap> {
        self.pending.get(&swap_id).cloned()
    }

    pub fn get_stranded(&self, account_id: AccountId, token: AccountId) -> U128 {
        U128(
            self.stranded
                .get(&(account_id, token))
                .copied()
                .unwrap_or(0),
        )
    }
}

impl Router {
    fn start_swap(&mut self, amount: u128, request: SwapDeposit) -> PromiseOrValue<U128> {
        if amount == 0 || request.token_out == self.usdc {
            return PromiseOrValue::Value(U128(amount));
        }
        let swap_id = self.next_swap_id;
        self.next_swap_id += 1;
        let pending = PendingSwap {
            battle_id: request.battle_id,
            side: request.side,
            beneficiary: request.beneficiary,
            token_out: request.token_out,
            min_token_out: request.min_token_out,
            usdc_in: U128(amount),
            from_credit: request.from_credit,
        };
        let dex_msg = msgs::dex_swap_msg(&pending, swap_id, &env::current_account_id());
        events::emit(
            "swap_started",
            json!({
                "swap_id": swap_id,
                "battle_id": pending.battle_id,
                "beneficiary": pending.beneficiary,
                "usdc_in": pending.usdc_in,
            }),
        );
        self.pending.insert(swap_id, pending);
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(DEX_TRANSFER_GAS)
            .ft_transfer_call(self.dex.clone(), U128(amount), None, dex_msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_swap_sent(swap_id, U128(amount)),
            )
            .into()
    }

    /// Handles the swapped coin coming back from the DEX. The pending record is
    /// removed only when the coin and amount match it, so a swap id is used once.
    fn finish_swap(
        &mut self,
        token: AccountId,
        amount: u128,
        swap_id: u64,
    ) -> PromiseOrValue<U128> {
        let valid = self
            .pending
            .get(&swap_id)
            .is_some_and(|p| p.token_out == token && amount >= p.min_token_out.0);
        if !valid {
            return PromiseOrValue::Value(U128(amount));
        }
        let Some(pending) = self.pending.remove(&swap_id) else {
            return PromiseOrValue::Value(U128(amount));
        };
        let arena_msg = msgs::arena_deposit_msg(&pending);
        events::emit(
            "swap_completed",
            json!({ "swap_id": swap_id, "token_out": token, "amount_out": U128(amount) }),
        );
        // Detached: the coin is fully accepted from the DEX; the router answers
        // for what the arena sends back.
        let _ = ext_ft::ext(token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(ARENA_TRANSFER_GAS)
            .ft_transfer_call(self.arena.clone(), U128(amount), None, arena_msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_deposit_sent(pending.beneficiary, token, U128(amount)),
            );
        PromiseOrValue::Value(U128(0))
    }

    fn add_stranded(&mut self, account: &AccountId, token: &AccountId, amount: u128) {
        let key = (account.clone(), token.clone());
        let current = self.stranded.get(&key).copied().unwrap_or(0);
        self.stranded.insert(key, current.saturating_add(amount));
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Only the owner can call this method"
        );
    }
}

#[cfg(test)]
mod tests;
