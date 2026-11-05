//! WAR, Valtrum's war bonds: an NEP-141 coin that carries a winner's locked
//! profit share.
//!
//! - 1 WAR is minted for each USDC the arena pays in, so the contract always
//!   holds the USDC that backs the coins.
//! - Every balance melts by `melt_ppm` parts per million at each step boundary
//!   counted from launch (4380 ppm per hour is 10% per day). Moving coins never
//!   restores or delays the melt.
//! - Only the arena can turn WAR back into USDC, by redeeming WAR it holds, which
//!   it does to fund battle deposits.
//! - The USDC whose WAR melted away is released by anyone to the arena's prize
//!   reserve.
//!
//! The rules are fixed by `new`, there is no owner, and the account is launched
//! without keys, so nobody can change them or the code.

pub mod melt;

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::events::{FtBurn, FtMint, FtTransfer};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::receiver::ext_ft_receiver;
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

const NS_PER_SEC: u64 = 1_000_000_000;
/// Shortest allowed step (for demos); launch uses 3600.
pub const MIN_STEP_SECS: u64 = 60;
/// Longest allowed step.
pub const MAX_STEP_SECS: u64 = 86_400;

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(60);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_RESOLVE: Gas = Gas::from_tgas(10);
const GAS_ON_TRANSFER_MIN: Gas = Gas::from_tgas(25);
/// Gas this method itself needs around the two promises.
const GAS_TRANSFER_CALL_OVERHEAD: Gas = Gas::from_tgas(10);

const EVENT_STANDARD: &str = "war";
const EVENT_VERSION: &str = "1.0.0";
/// Message the arena accepts for melted backing.
pub const PRIZE_RESERVE_MSG: &str = r#"{"action":"prize_reserve"}"#;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Holdings,
}

/// A balance as of the step it was last updated.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Holding {
    value: u128,
    step: u64,
    /// The account paid its own storage deposit (refunded on unregister).
    paid_storage: bool,
}

/// Messages accepted from USDC transfer calls.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", tag = "action", rename_all = "snake_case")]
enum UsdcMsg {
    Mint { receiver_id: AccountId },
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParamsView {
    pub launch_ns: U64,
    pub step_secs: U64,
    /// Parts per million lost at each step boundary.
    pub melt_ppm: u32,
    pub arena: AccountId,
    pub usdc: AccountId,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateView {
    pub step: U64,
    pub next_step_at_ns: U64,
    pub total_supply: U128,
    /// USDC held to back WAR.
    pub backing: U128,
    /// Backing above the total supply, ready for `release_melt`.
    pub melted_backing: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountView {
    pub balance: U128,
    /// What the balance loses at the next step boundary.
    pub next_loss: U128,
    pub next_step_at_ns: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct War {
    metadata: FungibleTokenMetadata,
    arena: AccountId,
    usdc: AccountId,
    melt_ppm: u32,
    step_ns: u64,
    launch_ns: u64,
    holdings: LookupMap<AccountId, Holding>,
    /// Total supply as of `total_step`; never below the sum of balances.
    total_value: u128,
    total_step: u64,
    backing: u128,
    /// Storage bytes one registered account uses.
    account_storage_usage: u64,
}

#[near]
impl War {
    #[init]
    pub fn new(arena: AccountId, usdc: AccountId, melt_ppm: u32, step_secs: U64) -> Self {
        let me = env::current_account_id();
        require!(arena != usdc, "The arena and USDC must differ");
        require!(
            arena != me && usdc != me,
            "WAR cannot be its own arena or USDC"
        );
        require!(
            (1..melt::PPM as u32).contains(&melt_ppm),
            "The melt must be between 1 and 999999 ppm"
        );
        require!(
            (MIN_STEP_SECS..=MAX_STEP_SECS).contains(&step_secs.0),
            "The step must be between 60 seconds and one day"
        );
        let mut this = Self {
            metadata: FungibleTokenMetadata {
                spec: FT_METADATA_SPEC.to_string(),
                name: "Valtrum War Bonds".to_string(),
                symbol: "WAR".to_string(),
                icon: None,
                reference: None,
                reference_hash: None,
                decimals: 6,
            },
            arena,
            usdc,
            melt_ppm,
            step_ns: step_secs.0 * NS_PER_SEC,
            launch_ns: env::block_timestamp(),
            holdings: LookupMap::new(StorageKey::Holdings),
            total_value: 0,
            total_step: 0,
            backing: 0,
            account_storage_usage: 0,
        };
        this.measure_account_storage();
        this
    }

    // ─── Arena: mint, redeem ────────────────────────────────────────────

    /// USDC receiver. Only the arena's USDC with a `mint` message mints WAR;
    /// anything else is refunded.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let parsed = serde_json::from_str::<UsdcMsg>(&msg);
        let receiver = match parsed {
            Ok(UsdcMsg::Mint { receiver_id })
                if token == self.usdc && sender_id == self.arena && amount.0 > 0 =>
            {
                receiver_id
            }
            _ => return PromiseOrValue::Value(amount),
        };
        let mut holding = self
            .synced(&receiver)
            .unwrap_or_else(|| self.new_holding(false));
        holding.value += amount.0;
        self.holdings.insert(receiver.clone(), holding);
        let total = self.synced_total() + amount.0;
        self.set_total(total);
        self.backing += amount.0;
        FtMint {
            owner_id: &receiver,
            amount,
            memo: Some("war bond"),
        }
        .emit();
        PromiseOrValue::Value(U128(0))
    }

    /// Burns `amount` of the arena's own WAR and pays the same amount of USDC to
    /// the arena. Only the arena may call it. Resolves to `true` once paid.
    pub fn redeem(&mut self, amount: U128) -> Promise {
        let arena = env::predecessor_account_id();
        require!(arena == self.arena, "Only the arena can redeem WAR");
        require!(amount.0 > 0, "The amount should be a positive number");
        self.withdraw(&arena, amount.0);
        self.backing -= amount.0;
        FtBurn {
            owner_id: &arena,
            amount,
            memo: Some("redeem"),
        }
        .emit();
        ext_ft_core::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(arena, amount, Some("WAR redeemed".to_string()))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_redeemed(amount),
            )
    }

    /// Puts the WAR back if the USDC payment failed.
    #[private]
    pub fn on_redeemed(
        &mut self,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            return true;
        }
        let arena = self.arena.clone();
        self.deposit(&arena, amount.0);
        self.backing += amount.0;
        FtMint {
            owner_id: &arena,
            amount,
            memo: Some("redeem refunded"),
        }
        .emit();
        false
    }

    // ─── Anyone: release the melt ───────────────────────────────────────

    /// Sends the backing that melted away to the arena's prize reserve.
    pub fn release_melt(&mut self) -> Promise {
        let total = self.synced_total();
        self.set_total(total);
        let melted = self.backing.saturating_sub(total);
        require!(melted > 0, "Nothing has melted yet");
        self.backing -= melted;
        ext_ft_core::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER_CALL)
            .ft_transfer_call(
                self.arena.clone(),
                U128(melted),
                Some("WAR melt".to_string()),
                PRIZE_RESERVE_MSG.to_string(),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_melt_released(U128(melted)),
            )
    }

    /// Books what the arena kept; anything it refused is backing again.
    #[private]
    pub fn on_melt_released(&mut self, amount: U128) -> U128 {
        let used = match env::promise_result_checked(0, 64) {
            Ok(bytes) => serde_json::from_slice::<U128>(&bytes)
                .map(|u| u.0.min(amount.0))
                .unwrap_or(0),
            Err(_) => 0,
        };
        self.backing += amount.0 - used;
        if used > 0 {
            emit("melt_released", json!({ "amount": U128(used) }));
        }
        U128(used)
    }

    // ─── Views ──────────────────────────────────────────────────────────

    pub fn get_params(&self) -> ParamsView {
        ParamsView {
            launch_ns: U64(self.launch_ns),
            step_secs: U64(self.step_ns / NS_PER_SEC),
            melt_ppm: self.melt_ppm,
            arena: self.arena.clone(),
            usdc: self.usdc.clone(),
        }
    }

    pub fn get_state(&self) -> StateView {
        let total = self.synced_total();
        StateView {
            step: U64(self.current_step()),
            next_step_at_ns: U64(self.next_step_at_ns()),
            total_supply: U128(total),
            backing: U128(self.backing),
            melted_backing: U128(self.backing.saturating_sub(total)),
        }
    }

    pub fn get_account(&self, account_id: AccountId) -> AccountView {
        let balance = self.synced(&account_id).map_or(0, |h| h.value);
        AccountView {
            balance: U128(balance),
            next_loss: U128(balance - melt::melt(balance, self.melt_ppm, 1)),
            next_step_at_ns: U64(self.next_step_at_ns()),
        }
    }

    // ─── Internals ──────────────────────────────────────────────────────

    fn current_step(&self) -> u64 {
        env::block_timestamp().saturating_sub(self.launch_ns) / self.step_ns
    }

    fn next_step_at_ns(&self) -> u64 {
        self.launch_ns + (self.current_step() + 1) * self.step_ns
    }

    fn new_holding(&self, paid_storage: bool) -> Holding {
        Holding {
            value: 0,
            step: self.current_step(),
            paid_storage,
        }
    }

    /// The account's holding melted up to the current step.
    fn synced(&self, account_id: &AccountId) -> Option<Holding> {
        let h = *self.holdings.get(account_id)?;
        let step = self.current_step();
        Some(Holding {
            value: melt::melt(h.value, self.melt_ppm, step.saturating_sub(h.step)),
            step,
            paid_storage: h.paid_storage,
        })
    }

    /// The total supply melted up to the current step, rounded up (see
    /// `melt::melt_upper`) so it never falls below the sum of balances.
    fn synced_total(&self) -> u128 {
        let steps = self.current_step().saturating_sub(self.total_step);
        melt::melt_upper(self.total_value, self.melt_ppm, steps)
    }

    fn set_total(&mut self, value: u128) {
        self.total_value = value;
        self.total_step = self.current_step();
    }

    fn withdraw(&mut self, account_id: &AccountId, amount: u128) {
        let mut h = self
            .synced(account_id)
            .unwrap_or_else(|| env::panic_str("The account is not registered"));
        require!(h.value >= amount, "The account doesn't have enough balance");
        h.value -= amount;
        self.holdings.insert(account_id.clone(), h);
        let total = self.synced_total();
        self.set_total(total.saturating_sub(amount));
    }

    fn deposit(&mut self, account_id: &AccountId, amount: u128) {
        let mut h = self
            .synced(account_id)
            .unwrap_or_else(|| env::panic_str("The account is not registered"));
        h.value += amount;
        self.holdings.insert(account_id.clone(), h);
        let total = self.synced_total();
        self.set_total(total + amount);
    }

    /// Moves current value between two registered accounts; the total is unchanged.
    fn transfer(&mut self, sender: &AccountId, receiver: &AccountId, amount: u128) {
        require!(
            sender != receiver,
            "Sender and receiver should be different"
        );
        require!(amount > 0, "The amount should be a positive number");
        let mut s = self
            .synced(sender)
            .unwrap_or_else(|| env::panic_str("The account is not registered"));
        let mut r = self.synced(receiver).unwrap_or_else(|| {
            env::panic_str(&format!("The account {receiver} is not registered"))
        });
        require!(s.value >= amount, "The account doesn't have enough balance");
        s.value -= amount;
        r.value += amount;
        self.holdings.insert(sender.clone(), s);
        self.holdings.insert(receiver.clone(), r);
    }

    fn measure_account_storage(&mut self) {
        let before = env::storage_usage();
        let tmp: AccountId = "a".repeat(64).parse().unwrap_or_else(|_| env::abort());
        self.holdings.insert(tmp.clone(), self.new_holding(true));
        self.holdings.flush();
        self.account_storage_usage = env::storage_usage() - before;
        self.holdings.remove(&tmp);
        self.holdings.flush();
    }

    fn storage_min(&self) -> NearToken {
        env::storage_byte_cost().saturating_mul(u128::from(self.account_storage_usage))
    }
}

/// Emits a NEP-297 event: `EVENT_JSON:{...}`.
fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let payload = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

// ─── NEP-141 ─────────────────────────────────────────────────────────────

#[near]
impl War {
    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        assert_one_yocto();
        let sender = env::predecessor_account_id();
        self.transfer(&sender, &receiver_id, amount.0);
        FtTransfer {
            old_owner_id: &sender,
            new_owner_id: &receiver_id,
            amount,
            memo: memo.as_deref(),
        }
        .emit();
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        assert_one_yocto();
        require!(
            env::prepaid_gas().saturating_sub(env::used_gas())
                >= GAS_ON_TRANSFER_MIN
                    .saturating_add(GAS_RESOLVE)
                    .saturating_add(GAS_TRANSFER_CALL_OVERHEAD),
            "More gas is required"
        );
        let sender = env::predecessor_account_id();
        self.transfer(&sender, &receiver_id, amount.0);
        FtTransfer {
            old_owner_id: &sender,
            new_owner_id: &receiver_id,
            amount,
            memo: memo.as_deref(),
        }
        .emit();
        let sent_step = U64(self.current_step());
        // The receiver gets its minimum plus all unused gas; the resolve keeps a fixed share.
        ext_ft_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_ON_TRANSFER_MIN)
            .with_unused_gas_weight(1)
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_RESOLVE)
                    .with_unused_gas_weight(0)
                    .ft_resolve_transfer(sender, receiver_id, amount, sent_step),
            )
    }

    /// Refunds what the receiver did not use, melted to the current step, so a
    /// refund never restores melt. Returns the amount used.
    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
        sent_step: U64,
    ) -> U128 {
        let unused = match env::promise_result_checked(0, 64) {
            Ok(bytes) => serde_json::from_slice::<U128>(&bytes)
                .map(|u| u.0.min(amount.0))
                .unwrap_or(amount.0),
            Err(_) => amount.0,
        };
        if unused == 0 {
            return amount;
        }
        let steps = self.current_step().saturating_sub(sent_step.0);
        let unused_now = melt::melt(unused, self.melt_ppm, steps);
        let Some(mut r) = self.synced(&receiver_id) else {
            return amount;
        };
        let refund = unused_now.min(r.value);
        if refund > 0 {
            r.value -= refund;
            self.holdings.insert(receiver_id.clone(), r);
            if let Some(mut s) = self.synced(&sender_id) {
                s.value += refund;
                self.holdings.insert(sender_id.clone(), s);
                FtTransfer {
                    old_owner_id: &receiver_id,
                    new_owner_id: &sender_id,
                    amount: U128(refund),
                    memo: Some("refund"),
                }
                .emit();
            } else {
                let total = self.synced_total();
                self.set_total(total.saturating_sub(refund));
                FtBurn {
                    owner_id: &receiver_id,
                    amount: U128(refund),
                    memo: Some("refund to a deleted sender"),
                }
                .emit();
            }
        }
        U128(amount.0 - unused)
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.synced_total())
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.synced(&account_id).map_or(0, |h| h.value))
    }
}

#[near]
impl FungibleTokenMetadataProvider for War {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}

// ─── NEP-145 ─────────────────────────────────────────────────────────────

#[near]
impl StorageManagement for War {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = registration_only;
        let attached = env::attached_deposit();
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let min = self.storage_min();
        if self.holdings.contains_key(&account) {
            if !attached.is_zero() {
                Promise::new(env::predecessor_account_id())
                    .transfer(attached)
                    .detach();
            }
        } else {
            require!(
                attached >= min,
                "The attached deposit is less than the minimum storage balance"
            );
            self.holdings
                .insert(account.clone(), self.new_holding(true));
            let refund = attached.saturating_sub(min);
            if !refund.is_zero() {
                Promise::new(env::predecessor_account_id())
                    .transfer(refund)
                    .detach();
            }
        }
        StorageBalance {
            total: min,
            available: NearToken::from_yoctonear(0),
        }
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        require!(
            self.holdings.contains_key(&account),
            "The account is not registered"
        );
        if let Some(amount) = amount {
            require!(
                amount.is_zero(),
                "The amount is greater than the available storage balance"
            );
        }
        StorageBalance {
            total: self.storage_min(),
            available: NearToken::from_yoctonear(0),
        }
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let Some(h) = self.synced(&account) else {
            return false;
        };
        require!(
            h.value == 0 || force.unwrap_or(false),
            "Can't unregister the account with the positive balance without force"
        );
        self.holdings.remove(&account);
        if h.value > 0 {
            let total = self.synced_total();
            self.set_total(total.saturating_sub(h.value));
            FtBurn {
                owner_id: &account,
                amount: U128(h.value),
                memo: Some("forced unregister"),
            }
            .emit();
        }
        if h.paid_storage {
            Promise::new(account).transfer(self.storage_min()).detach();
        }
        true
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        let min = self.storage_min();
        StorageBalanceBounds {
            min,
            max: Some(min),
        }
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.holdings
            .contains_key(&account_id)
            .then(|| StorageBalance {
                total: self.storage_min(),
                available: NearToken::from_yoctonear(0),
            })
    }
}

#[cfg(test)]
mod tests;
