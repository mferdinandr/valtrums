//! Mock DEX for testnet: fixed rates, no slippage, owner-funded liquidity.
//!
//! Swaps are triggered through `ft_on_transfer` with a `swap` message. The
//! decision to swap is taken synchronously, so a refused swap returns the whole
//! input as unused. An accepted swap pays the output with `ft_transfer_call`
//! and restores it to liquidity if the receiver hands it back.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    PromiseError, PromiseOrValue,
};

mod math;

use math::mul_div;

/// Gas for the output `ft_transfer_call`. The receiver runs inside this budget.
const FT_TRANSFER_CALL_GAS: Gas = Gas::from_tgas(90);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Rates,
    Liquidity,
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
}

/// Messages accepted through `ft_transfer_call`.
#[near(serializers = [json])]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum TransferMsg {
    Swap {
        token_out: AccountId,
        min_amount_out: U128,
        receiver_id: AccountId,
        receiver_msg: String,
    },
    AddLiquidity,
}

/// Fixed exchange rate: `out = in * num / den`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rate {
    pub num: U128,
    pub den: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockDex {
    owner: AccountId,
    rates: LookupMap<(AccountId, AccountId), Rate>,
    /// Coin balances the DEX can pay out, credited by swaps in and `add_liquidity`.
    liquidity: LookupMap<AccountId, u128>,
}

#[near]
impl MockDex {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            rates: LookupMap::new(StorageKey::Rates),
            liquidity: LookupMap::new(StorageKey::Liquidity),
        }
    }

    /// Sets the rate `out = in * num / den` for a token pair.
    pub fn set_rate(&mut self, token_in: AccountId, token_out: AccountId, num: U128, den: U128) {
        self.assert_owner();
        require!(num.0 > 0 && den.0 > 0, "Rate parts must be positive");
        self.rates.insert((token_in, token_out), Rate { num, den });
    }

    /// NEP-141 receiver. `swap` swaps the received coin; `add_liquidity` (owner
    /// only) credits liquidity. Anything else is returned in full.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        match serde_json::from_str::<TransferMsg>(&msg) {
            Ok(TransferMsg::AddLiquidity) if sender_id == self.owner => {
                self.credit(&token, amount.0);
                env::log_str(&format!("liquidity_added:{token}:{}", amount.0));
                PromiseOrValue::Value(U128(0))
            }
            Ok(TransferMsg::Swap {
                token_out,
                min_amount_out,
                receiver_id,
                receiver_msg,
            }) => self.handle_swap(
                token,
                amount.0,
                token_out,
                min_amount_out.0,
                receiver_id,
                receiver_msg,
            ),
            _ => PromiseOrValue::Value(amount),
        }
    }

    /// Restores the output to liquidity when the receiver did not keep all of it.
    #[private]
    pub fn on_output_sent(
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
            self.credit(&token_out, unused);
        }
        env::log_str(&format!("output_unused:{token_out}:{unused}"));
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_rate(&self, token_in: AccountId, token_out: AccountId) -> Option<Rate> {
        self.rates.get(&(token_in, token_out)).copied()
    }

    pub fn get_liquidity(&self, token: AccountId) -> U128 {
        U128(self.liquidity.get(&token).copied().unwrap_or(0))
    }
}

impl MockDex {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Only the owner can call this method"
        );
    }

    fn credit(&mut self, token: &AccountId, amount: u128) {
        let current = self.liquidity.get(token).copied().unwrap_or(0);
        self.liquidity
            .insert(token.clone(), current.saturating_add(amount));
    }

    /// Quote for a swap, or `None` when it must be refused.
    fn quote(
        &self,
        token_in: &AccountId,
        token_out: &AccountId,
        amount: u128,
        min_out: u128,
    ) -> Option<u128> {
        let rate = self.rates.get(&(token_in.clone(), token_out.clone()))?;
        let out = mul_div(amount, rate.num.0, rate.den.0)?;
        let available = self.liquidity.get(token_out).copied().unwrap_or(0);
        (out > 0 && out >= min_out && out <= available).then_some(out)
    }

    fn handle_swap(
        &mut self,
        token_in: AccountId,
        amount: u128,
        token_out: AccountId,
        min_out: u128,
        receiver_id: AccountId,
        receiver_msg: String,
    ) -> PromiseOrValue<U128> {
        let Some(out) = self.quote(&token_in, &token_out, amount, min_out) else {
            return PromiseOrValue::Value(U128(amount));
        };
        let available = self.liquidity.get(&token_out).copied().unwrap_or(0);
        self.liquidity.insert(token_out.clone(), available - out);
        self.credit(&token_in, amount);
        env::log_str(
            &json!({ "swap": { "in": token_in, "amount_in": amount.to_string(), "out": token_out, "amount_out": out.to_string() } })
                .to_string(),
        );
        // The output goes out as a detached call so the input is reported as used.
        let _ = ext_ft::ext(token_out.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_CALL_GAS)
            .ft_transfer_call(receiver_id, U128(out), None, receiver_msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_output_sent(token_out, U128(out)),
            );
        PromiseOrValue::Value(U128(0))
    }
}

#[cfg(test)]
mod tests;
