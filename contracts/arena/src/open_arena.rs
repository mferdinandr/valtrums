//! Open arena: a start time, a protocol allowlist of joinable tokens, joining
//! by deposit, cancel and pull-based refund.
//!
//! None of this state is a field of `Arena`, `Battle`, `Community` or `Snapshot`:
//! the borsh layout of every existing record is unchanged, so the code can be
//! redeployed over live state. New data lives in standalone maps that are built
//! on demand from storage keys appended at the end of `StorageKey`. A map built
//! this way owns no length counter, so the allowlist order is kept in one
//! bounded vector instead of an iterable collection.
use crate::lifecycle::{same_slot, validate_asset, AssetIdentity, AssetInput, LifecycleError};
use crate::{events, ext_ft, Arena, ArenaExt, StorageKey};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseError};

/// Earliest start, counted from creation.
pub const MIN_START_LEAD_MS: u64 = 60_000;
/// Latest start, counted from creation (7 days).
pub const MAX_START_LEAD_MS: u64 = 7 * 24 * 60 * 60 * 1_000;
/// Most tokens the protocol can list as joinable; bounds scans and the index read.
pub const MAX_JOINABLE_ASSETS: usize = 64;
/// Most entries one page of `get_lifecycle_joinable_assets` returns.
const MAX_JOINABLE_PAGE: u64 = 50;
const REFUND_TRANSFER_GAS: Gas = Gas::from_tgas(10);
const REFUND_CALLBACK_GAS: Gas = Gas::from_tgas(10);

fn start_map() -> LookupMap<u64, u64> {
    LookupMap::new(StorageKey::LifecycleStart)
}

fn joinable_map() -> LookupMap<AccountId, AssetIdentity> {
    LookupMap::new(StorageKey::LifecycleJoinable)
}

/// The allowlist order, kept under one key (0) so pages stay stable.
fn joinable_index_map() -> LookupMap<u8, Vec<AccountId>> {
    LookupMap::new(StorageKey::LifecycleJoinableIndex)
}

fn cancelled_map() -> LookupMap<u64, bool> {
    LookupMap::new(StorageKey::LifecycleCancelled)
}

impl Arena {
    /// Start time (ms since epoch) of a battle created with one.
    pub(crate) fn lifecycle_start_of(&self, battle_id: u64) -> Option<u64> {
        start_map().get(&battle_id).copied()
    }

    pub(crate) fn lifecycle_is_cancelled(&self, battle_id: u64) -> bool {
        cancelled_map().get(&battle_id).copied().unwrap_or(false)
    }

    /// Stores a start time already checked by `lifecycle_check_start`.
    pub(crate) fn lifecycle_set_start(&mut self, battle_id: u64, start_at_ms: u64) {
        let mut map = start_map();
        map.insert(battle_id, start_at_ms);
        map.flush();
    }

    /// Checks a start time before any state changes.
    pub(crate) fn lifecycle_check_start(start_at_ms: u64) {
        let now = env::block_timestamp_ms();
        require!(
            start_at_ms >= now.saturating_add(MIN_START_LEAD_MS)
                && start_at_ms <= now.saturating_add(MAX_START_LEAD_MS),
            "Start time must be 1 minute to 7 days ahead"
        );
    }

    fn assert_protocol_caller(&self) {
        require!(
            self.lifecycle_protocol.as_ref() == Some(&env::predecessor_account_id()),
            "Only the protocol account can change the joinable assets"
        );
    }
}

#[near]
impl Arena {
    /// Protocol account only, exactly one yocto. Lists (or replaces) a token that
    /// anyone may bring into an open arena. The arena, not the joiner, supplies
    /// the asset identity, which prevents identity squatting. A replaced entry
    /// affects only later joins; existing communities keep their identity.
    #[payable]
    pub fn set_lifecycle_joinable_asset(&mut self, asset: AssetInput) {
        near_sdk::assert_one_yocto();
        self.assert_protocol_caller();
        require!(
            asset.representation != self.usdc,
            "USDC cannot be a lifecycle representation"
        );
        let identity = validate_asset(asset.into())
            .unwrap_or_else(|_| env::panic_str("Invalid joinable asset"));
        self.assert_registered_references(std::slice::from_ref(&identity));
        let mut map = joinable_map();
        let mut index_map = joinable_index_map();
        let mut index = index_map.get(&0).cloned().unwrap_or_default();
        let existing = map.contains_key(&identity.representation);
        if !existing {
            require!(
                index.len() < MAX_JOINABLE_ASSETS,
                "Too many joinable assets"
            );
        }
        for other in index
            .iter()
            .filter(|other| **other != identity.representation)
        {
            let other_asset = map
                .get(other)
                .unwrap_or_else(|| env::panic_str("Joinable index is inconsistent"));
            require!(
                !same_slot(other_asset, &identity),
                "Another joinable asset has the same token or reference"
            );
        }
        let representation = identity.representation.clone();
        map.insert(representation.clone(), identity);
        map.flush();
        if !existing {
            index.push(representation.clone());
            index_map.insert(0, index);
            index_map.flush();
        }
        events::emit(
            "lifecycle_joinable_asset_set",
            json!({ "representation": representation }),
        );
    }

    /// Protocol account only, exactly one yocto. Stops new joins with the token;
    /// communities that already exist are unaffected.
    #[payable]
    pub fn remove_lifecycle_joinable_asset(&mut self, representation: AccountId) {
        near_sdk::assert_one_yocto();
        self.assert_protocol_caller();
        let mut map = joinable_map();
        require!(
            map.contains_key(&representation),
            "Token is not a joinable asset"
        );
        map.remove(&representation);
        map.flush();
        let mut index_map = joinable_index_map();
        let mut index = index_map.get(&0).cloned().unwrap_or_default();
        index.retain(|item| item != &representation);
        index_map.insert(0, index);
        index_map.flush();
        events::emit(
            "lifecycle_joinable_asset_removed",
            json!({ "representation": representation }),
        );
    }

    pub fn get_lifecycle_joinable_asset(&self, representation: AccountId) -> Option<AssetInput> {
        joinable_map().get(&representation).cloned().map(Into::into)
    }

    /// One bounded page of the allowlist, in listing order.
    pub fn get_lifecycle_joinable_assets(&self, from_index: U64, limit: U64) -> Vec<AssetInput> {
        let map = joinable_map();
        let index = joinable_index_map().get(&0).cloned().unwrap_or_default();
        let take = limit.0.min(MAX_JOINABLE_PAGE) as usize;
        let skip = usize::try_from(from_index.0).unwrap_or(usize::MAX);
        index
            .iter()
            .skip(skip)
            .take(take)
            .filter_map(|representation| map.get(representation).cloned())
            .map(Into::into)
            .collect()
    }

    /// Joins an open arena with an allowlisted token and returns the community
    /// index. The first join of a token appends its community; later joins reuse
    /// it. The caller's position is registered here, so a deposit can follow at
    /// once. Attached NEAR pays the measured storage and the excess is refunded.
    #[payable]
    pub fn join_lifecycle_battle(&mut self, battle_id: u64, representation: AccountId) -> u32 {
        require!(!self.paused, "Arena is paused");
        require!(self.lifecycle_exclusive, "Lifecycle is not activated");
        self.lifecycle_assert_entry_open(battle_id)
            .unwrap_or_else(|_| env::panic_str("Joining is closed"));
        let asset = joinable_map()
            .get(&representation)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Token is not joinable"));
        let mut battle = self
            .lifecycle_battles
            .get(&battle_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Unknown battle"));
        require!(!battle.is_locked(), "Battle is locked");
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        let (community, added) = match battle.community_index_of(&asset) {
            Some(index) => (index, false),
            None => {
                require!(
                    !battle.conflicts_with(&asset),
                    "Token conflicts with an existing community"
                );
                let index = battle.add_community(asset).unwrap_or_else(|error| {
                    env::panic_str(match error {
                        LifecycleError::TooManyCommunities => "Arena is full",
                        LifecycleError::DuplicateAsset => "Token is already in the arena",
                        _ => "Cannot add community",
                    })
                });
                (index, true)
            }
        };
        if added {
            self.lifecycle_battles.insert(battle_id, battle);
            self.lifecycle_battles.flush();
        }
        let key = (battle_id, community, account.clone());
        if !self.lifecycle_positions.contains_key(&key) {
            self.lifecycle_positions.insert(key, 0);
            self.lifecycle_positions.flush();
        }
        self.charge_storage(before);
        if added {
            events::emit(
                "lifecycle_community_added",
                json!({
                    "battle_id": battle_id,
                    "community": community,
                    "representation": representation,
                    "account_id": account,
                }),
            );
        }
        community
    }

    /// Anyone may cancel once the start time has passed with fewer than two
    /// funded communities. Deposits are then refundable with
    /// `claim_lifecycle_refund`; joins, deposits and lock are refused.
    pub fn cancel_lifecycle_battle(&mut self, battle_id: u64) {
        let start = self
            .lifecycle_start_of(battle_id)
            .unwrap_or_else(|| env::panic_str("Battle has no start time"));
        require!(
            env::block_timestamp_ms() >= start,
            "Start time has not been reached"
        );
        let battle = self
            .lifecycle_battles
            .get(&battle_id)
            .unwrap_or_else(|| env::panic_str("Unknown battle"));
        require!(!battle.is_locked(), "Battle is locked");
        require!(
            !self.lifecycle_is_cancelled(battle_id),
            "Battle is already cancelled"
        );
        require!(
            battle.funded_indices().len() < 2,
            "At least two communities are funded"
        );
        let mut map = cancelled_map();
        map.insert(battle_id, true);
        map.flush();
        events::emit(
            "lifecycle_battle_cancelled",
            json!({ "battle_id": battle_id }),
        );
    }

    /// Pays the caller's deposit back after a cancel. The position and vault are
    /// reduced before the transfer; a failed transfer restores them in the
    /// callback, so a repeated call can never pay twice.
    #[payable]
    pub fn claim_lifecycle_refund(&mut self, battle_id: u64, community: u32) -> Promise {
        near_sdk::assert_one_yocto();
        require!(
            self.lifecycle_is_cancelled(battle_id),
            "Battle is not cancelled"
        );
        let account = env::predecessor_account_id();
        let key = (battle_id, community, account.clone());
        let amount = self.lifecycle_positions.get(&key).copied().unwrap_or(0);
        require!(amount > 0, "Nothing to refund");
        let mut battle = self
            .lifecycle_battles
            .get(&battle_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Unknown battle"));
        let token = battle
            .community_asset(community as usize)
            .unwrap_or_else(|| env::panic_str("Unknown community"))
            .representation
            .clone();
        battle
            .debit_vault(community, amount)
            .unwrap_or_else(|_| env::panic_str("Vault accounting failed"));
        self.lifecycle_positions.insert(key, 0);
        self.lifecycle_battles.insert(battle_id, battle);
        ext_ft::ext(token)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(REFUND_TRANSFER_GAS)
            .ft_transfer(account.clone(), U128(amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(REFUND_CALLBACK_GAS)
                    .on_lifecycle_refund(battle_id, community, account, U128(amount)),
            )
    }

    /// Restores the position and vault when the refund transfer failed.
    #[private]
    pub fn on_lifecycle_refund(
        &mut self,
        battle_id: u64,
        community: u32,
        account_id: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            events::emit(
                "lifecycle_refund",
                json!({
                    "battle_id": battle_id,
                    "community": community,
                    "account_id": account_id,
                    "amount": amount,
                }),
            );
            return true;
        }
        let key = (battle_id, community, account_id.clone());
        let position = self.lifecycle_positions.get(&key).copied().unwrap_or(0);
        self.lifecycle_positions
            .insert(key, position.saturating_add(amount.0));
        if let Some(mut battle) = self.lifecycle_battles.get(&battle_id).cloned() {
            if battle.restore_vault(community, amount.0).is_ok() {
                self.lifecycle_battles.insert(battle_id, battle);
            }
        }
        events::emit(
            "lifecycle_refund_failed",
            json!({
                "battle_id": battle_id,
                "community": community,
                "account_id": account_id,
                "amount": amount,
            }),
        );
        false
    }

    pub fn get_lifecycle_start(&self, battle_id: u64) -> Option<U64> {
        self.lifecycle_start_of(battle_id).map(U64)
    }

    pub fn is_lifecycle_cancelled(&self, battle_id: u64) -> bool {
        self.lifecycle_is_cancelled(battle_id)
    }
}
