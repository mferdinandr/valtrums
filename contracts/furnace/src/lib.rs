//! The furnace: where Valtrum burns coins.
//!
//! It accepts any NEP-141 coin through `ft_transfer_call`, keeps the full
//! amount, and has no method that sends, withdraws or approves anything. It is
//! launched without keys, so coins sent here are out of circulation for good.
//!
//! Every accepted transfer call is recorded per coin, per battle (when the
//! message names one) and per sender, so a page can show what Valtrum burned
//! without an indexer. Coins sent with a plain `ft_transfer` are kept too, but
//! the furnace is not told about them, so they are not recorded.

use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, AccountId, BorshStorageKey, PanicOnDefault, PromiseOrValue};

/// Largest page returned by the list views.
pub const MAX_PAGE: u32 = 100;

const EVENT_STANDARD: &str = "furnace";
const EVENT_VERSION: &str = "1.0.0";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Totals,
    BattleCoins,
    BattleBurns,
    SenderTotals,
}

/// The optional message of a burn.
#[derive(Deserialize, Default)]
#[serde(crate = "near_sdk::serde")]
struct BurnMsg {
    battle_id: Option<u64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoinBurn {
    pub token_id: AccountId,
    pub burned: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Furnace {
    /// Recorded total per coin.
    totals: IterableMap<AccountId, u128>,
    /// Coins each battle burned, in the order they first arrived.
    battle_coins: LookupMap<u64, Vec<AccountId>>,
    battle_burns: LookupMap<(u64, AccountId), u128>,
    sender_totals: LookupMap<(AccountId, AccountId), u128>,
}

#[near]
impl Furnace {
    #[init]
    pub fn new() -> Self {
        Self {
            totals: IterableMap::new(StorageKey::Totals),
            battle_coins: LookupMap::new(StorageKey::BattleCoins),
            battle_burns: LookupMap::new(StorageKey::BattleBurns),
            sender_totals: LookupMap::new(StorageKey::SenderTotals),
        }
    }

    /// NEP-141 receiver. Keeps every coin and records the burn. The message may
    /// be empty or `{"battle_id": <id>}`; anything else counts as no battle.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if amount.0 == 0 {
            return PromiseOrValue::Value(U128(0));
        }
        let token = env::predecessor_account_id();
        let battle_id = serde_json::from_str::<BurnMsg>(&msg)
            .unwrap_or_default()
            .battle_id;

        let total = self.totals.get(&token).copied().unwrap_or(0);
        self.totals
            .insert(token.clone(), total.saturating_add(amount.0));

        let key = (token.clone(), sender_id.clone());
        let by_sender = self.sender_totals.get(&key).copied().unwrap_or(0);
        self.sender_totals
            .insert(key, by_sender.saturating_add(amount.0));

        if let Some(id) = battle_id {
            let key = (id, token.clone());
            let by_battle = self.battle_burns.get(&key).copied();
            if by_battle.is_none() {
                let mut coins = self.battle_coins.get(&id).cloned().unwrap_or_default();
                coins.push(token.clone());
                self.battle_coins.insert(id, coins);
            }
            self.battle_burns
                .insert(key, by_battle.unwrap_or(0).saturating_add(amount.0));
        }

        emit(
            "furnace_burned",
            json!({
                "token_id": token,
                "amount": amount,
                "sender_id": sender_id,
                "battle_id": battle_id,
            }),
        );
        PromiseOrValue::Value(U128(0))
    }

    // ─── Views ──────────────────────────────────────────────────────────

    /// Recorded total of one coin.
    pub fn get_total(&self, token_id: AccountId) -> U128 {
        U128(self.totals.get(&token_id).copied().unwrap_or(0))
    }

    /// Number of coins with a recorded burn.
    pub fn get_coin_count(&self) -> u32 {
        self.totals.len()
    }

    /// Recorded coins with their totals, in the order they first arrived.
    pub fn get_coins(&self, from_index: u32, limit: u32) -> Vec<CoinBurn> {
        self.totals
            .iter()
            .skip(from_index as usize)
            .take(limit.min(MAX_PAGE) as usize)
            .map(|(token_id, burned)| CoinBurn {
                token_id: token_id.clone(),
                burned: U128(*burned),
            })
            .collect()
    }

    /// Coins one battle burned, with amounts.
    pub fn get_battle_burns(&self, battle_id: u64) -> Vec<CoinBurn> {
        self.battle_coins
            .get(&battle_id)
            .map(|coins| {
                coins
                    .iter()
                    .map(|token_id| CoinBurn {
                        token_id: token_id.clone(),
                        burned: U128(
                            self.battle_burns
                                .get(&(battle_id, token_id.clone()))
                                .copied()
                                .unwrap_or(0),
                        ),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// What one sender burned of one coin.
    pub fn get_sender_total(&self, token_id: AccountId, sender_id: AccountId) -> U128 {
        U128(
            self.sender_totals
                .get(&(token_id, sender_id))
                .copied()
                .unwrap_or(0),
        )
    }
}

/// Emits a NEP-297 event: `EVENT_JSON:{...}`.
fn emit(event: &str, data: Value) {
    let payload = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

#[cfg(test)]
mod tests;
