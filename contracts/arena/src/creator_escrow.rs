//! Creator escrow (D41): a battle is created only by a deposit of the creator's token.
//!
//! The token arrives through `ft_transfer_call` with a `lifecycle_create` message. The arena creates the
//! battle, adds the creator's community from the protocol allowlist, registers the creator and holds the
//! tokens in an escrow that is separate from every community vault. The escrow converts to the creator's
//! credited position when the community holds both its audit and its backing approval, so an unapproved
//! token never sits in a vault. It leaves the arena only by that conversion or by a refund to its creator
//! after a cancel.
//!
//! Like the open arena, none of this state is a field of `Arena`, `Battle`, `Community` or `Snapshot`: it
//! lives in standalone maps under keys appended at the end of `StorageKey`, so the code can be redeployed
//! over live state. A battle created before this change has no escrow and keeps its earlier behavior.
//!
//! Storage is paid from a NEAR balance the creator prepaid here: `ft_on_transfer` carries no NEAR.
use crate::lifecycle::{AssetIdentity, Battle, FeePolicy, ScoringMode};
use crate::{events, ext_ft, Arena, ArenaExt, StorageKey};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseError};

const ESCROW_REFUND_TRANSFER_GAS: Gas = Gas::from_tgas(10);
const ESCROW_REFUND_CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// The creator's community is always the first one of the battle.
pub const CREATOR_COMMUNITY: u32 = 0;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreatorEscrow {
    pub creator: AccountId,
    pub representation: AccountId,
    pub amount: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreatorEscrowView {
    pub creator: AccountId,
    pub representation: AccountId,
    pub amount: U128,
    /// Always false while the escrow exists: a converted escrow is removed and the position is credited.
    pub credited: bool,
}

fn escrow_map() -> LookupMap<u64, CreatorEscrow> {
    LookupMap::new(StorageKey::LifecycleCreatorEscrow)
}

fn storage_balance_map() -> LookupMap<AccountId, u128> {
    LookupMap::new(StorageKey::LifecycleStorageBalance)
}

impl Arena {
    pub(crate) fn lifecycle_creator_escrow_of(&self, battle_id: u64) -> Option<CreatorEscrow> {
        escrow_map().get(&battle_id).cloned()
    }

    fn lifecycle_storage_balance_of(&self, account: &AccountId) -> u128 {
        storage_balance_map().get(account).copied().unwrap_or(0)
    }

    /// Creates the battle record without any payment. Shared by the escrow creation and the test helper.
    pub(crate) fn lifecycle_create_inner(
        &mut self,
        creator: &AccountId,
        assets: Vec<AssetIdentity>,
        mode: ScoringMode,
        start_at_ms: Option<u64>,
    ) -> u64 {
        let protocol = self
            .lifecycle_protocol
            .clone()
            .unwrap_or_else(|| env::panic_str("Lifecycle protocol is not configured"));
        let fee = FeePolicy {
            fee_bps: self.lifecycle_fee_bps,
            creator_share_bps: self.lifecycle_creator_share_bps,
            protocol_created: *creator == protocol,
            creator: creator.clone(),
            protocol,
        };
        // A reference pair is accepted only when it equals the protocol registry entry.
        self.assert_registered_references(&assets);
        let battle = Battle::new(assets, mode, fee)
            .unwrap_or_else(|_| env::panic_str("Invalid lifecycle battle"));
        let id = self
            .lifecycle_insert(battle)
            .unwrap_or_else(|_| env::panic_str("Battle count overflow"));
        if let Some(start) = start_at_ms {
            self.lifecycle_set_start(id, start);
        }
        // The DAO vote window is frozen with the battle; a later change applies only to battles created
        // afterwards. Unset means no vote (stays escrowed).
        if let Some(window) = self.lifecycle_dao_window_ns {
            self.lifecycle_dao_windows.insert(id, window);
            self.lifecycle_dao_windows.flush();
        }
        self.lifecycle_battles.flush();
        id
    }

    /// Why a creation would be refused, found before any state changes so the transfer can be returned
    /// without a panic. Storage is the one check that needs the writes first; it panics, which reverts them
    /// and makes the token return the whole transfer.
    fn lifecycle_create_problem(
        &self,
        token: &AccountId,
        amount: u128,
        start_at_ms: u64,
    ) -> Option<&'static str> {
        if !self.lifecycle_exclusive {
            return Some("lifecycle is not activated");
        }
        if amount == 0 {
            return Some("the deposit must be positive");
        }
        if self.lifecycle_joinable_asset_of(token).is_none() {
            return Some("the token is not joinable");
        }
        let now = env::block_timestamp_ms();
        if start_at_ms < now.saturating_add(crate::open_arena::MIN_START_LEAD_MS)
            || start_at_ms > now.saturating_add(crate::open_arena::MAX_START_LEAD_MS)
        {
            return Some("the start time must be 1 minute to 7 days ahead");
        }
        if self.lifecycle_protocol.is_none() {
            return Some("the lifecycle protocol is not configured");
        }
        None
    }

    /// Creates a battle with the creator's escrowed deposit. `Err` carries the reason the transfer must be
    /// returned; it changes no state. See the module comment for the rules.
    pub(crate) fn lifecycle_create_with_escrow(
        &mut self,
        creator: &AccountId,
        token: &AccountId,
        amount: u128,
        mode: ScoringMode,
        start_at_ms: u64,
    ) -> Result<u64, &'static str> {
        if let Some(problem) = self.lifecycle_create_problem(token, amount, start_at_ms) {
            return Err(problem);
        }
        // Refuses a mode no observation policy can run; a panic reverts the call and returns the transfer.
        self.lifecycle_assert_mode_offered(mode);
        let asset = self
            .lifecycle_joinable_asset_of(token)
            .ok_or("the token is not joinable")?;
        let before = env::storage_usage();
        let id = self.lifecycle_create_inner(creator, vec![asset], mode, Some(start_at_ms));
        let key = (id, CREATOR_COMMUNITY, creator.clone());
        self.lifecycle_positions.insert(key, 0);
        self.lifecycle_positions.flush();
        let mut escrows = escrow_map();
        escrows.insert(
            id,
            CreatorEscrow {
                creator: creator.clone(),
                representation: token.clone(),
                amount,
            },
        );
        escrows.flush();
        // Storage comes out of the balance the creator prepaid; a shortfall reverts everything above.
        let cost = env::storage_byte_cost()
            .as_yoctonear()
            .checked_mul(u128::from(env::storage_usage().saturating_sub(before)))
            .unwrap_or_else(|| env::panic_str("Storage cost overflow"));
        let mut balances = storage_balance_map();
        let balance = balances.get(creator).copied().unwrap_or(0);
        require!(
            balance >= cost,
            "Prepaid storage balance is too small: call lifecycle_storage_deposit first"
        );
        balances.insert(creator.clone(), balance - cost);
        balances.flush();
        events::emit(
            "lifecycle_battle_created",
            json!({ "battle_id": id, "creator": creator }),
        );
        events::emit(
            "lifecycle_community_added",
            json!({
                "battle_id": id,
                "community": CREATOR_COMMUNITY,
                "representation": token,
                "account_id": creator,
            }),
        );
        events::emit(
            "lifecycle_creator_escrow_held",
            json!({
                "battle_id": id,
                "account_id": creator,
                "representation": token,
                "amount": U128(amount),
            }),
        );
        Ok(id)
    }

    /// Turns the creator escrow into the creator's credited position once the creator's community holds both
    /// approvals. Returns whether it converted. Nothing happens for a battle without an escrow, a cancelled
    /// or locked battle, or a community that still lacks an approval. The deposit was made before the start,
    /// so converting after the start is allowed; it only changes who can cancel.
    pub(crate) fn lifecycle_convert_creator_escrow(&mut self, battle_id: u64) -> bool {
        let Some(escrow) = self.lifecycle_creator_escrow_of(battle_id) else {
            return false;
        };
        if self.lifecycle_is_cancelled(battle_id) {
            return false;
        }
        let Some(mut battle) = self.lifecycle_battles.get(&battle_id).cloned() else {
            return false;
        };
        let key = (battle_id, CREATOR_COMMUNITY, escrow.creator.clone());
        let prior = self.lifecycle_positions.get(&key).copied().unwrap_or(0);
        // `credit` itself refuses a missing approval, a locked battle and the wrong representation.
        let Ok(next) = battle.credit(
            CREATOR_COMMUNITY as usize,
            &escrow.representation,
            &escrow.creator,
            prior,
            escrow.amount,
        ) else {
            return false;
        };
        if prior == 0
            && self
                .lifecycle_index_participant(battle_id, CREATOR_COMMUNITY, &escrow.creator)
                .is_err()
        {
            return false;
        }
        self.lifecycle_positions.insert(key, next);
        self.lifecycle_positions.flush();
        self.lifecycle_battles.insert(battle_id, battle);
        self.lifecycle_battles.flush();
        let mut escrows = escrow_map();
        escrows.remove(&battle_id);
        escrows.flush();
        events::emit(
            "lifecycle_creator_escrow_credited",
            json!({
                "battle_id": battle_id,
                "account_id": escrow.creator,
                "representation": escrow.representation,
                "amount": U128(escrow.amount),
            }),
        );
        true
    }

    /// Whether a battle's creator escrow is still held (uncredited). Such a battle can be cancelled after
    /// its start even when two communities are funded.
    pub(crate) fn lifecycle_has_held_escrow(&self, battle_id: u64) -> bool {
        self.lifecycle_creator_escrow_of(battle_id).is_some()
    }
}

#[near]
impl Arena {
    /// Prepays NEAR that pays the storage of battles the account creates. Not a bond: nothing in it is
    /// slashed and the unused part is withdrawable. `account_id` names the beneficiary (default: the caller).
    #[payable]
    pub fn lifecycle_storage_deposit(&mut self, account_id: Option<AccountId>) -> U128 {
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached > 0, "Attach NEAR to prepay storage");
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let mut balances = storage_balance_map();
        let next = balances
            .get(&who)
            .copied()
            .unwrap_or(0)
            .checked_add(attached)
            .unwrap_or_else(|| env::panic_str("Balance overflow"));
        balances.insert(who.clone(), next);
        balances.flush();
        events::emit(
            "lifecycle_storage_deposited",
            json!({ "account_id": who, "amount": U128(attached) }),
        );
        U128(next)
    }

    /// Returns prepaid NEAR that no storage uses; exactly one yocto, caller only. `None` takes everything.
    /// The balance is reduced before the transfer.
    #[payable]
    pub fn lifecycle_storage_withdraw(&mut self, amount: Option<U128>) -> U128 {
        near_sdk::assert_one_yocto();
        let who = env::predecessor_account_id();
        let mut balances = storage_balance_map();
        let balance = balances.get(&who).copied().unwrap_or(0);
        let take = amount.map_or(balance, |a| a.0);
        require!(take > 0 && take <= balance, "Nothing to withdraw");
        balances.insert(who.clone(), balance - take);
        balances.flush();
        Promise::new(who.clone())
            .transfer(NearToken::from_yoctonear(take))
            .detach();
        events::emit(
            "lifecycle_storage_withdrawn",
            json!({ "account_id": who, "amount": U128(take) }),
        );
        U128(take)
    }

    pub fn get_lifecycle_storage_balance(&self, account_id: AccountId) -> U128 {
        U128(self.lifecycle_storage_balance_of(&account_id))
    }

    /// The creator escrow of a battle while it is held; `None` after conversion, after a refund and for a
    /// battle created before this change.
    pub fn get_lifecycle_creator_escrow(&self, battle_id: u64) -> Option<CreatorEscrowView> {
        self.lifecycle_creator_escrow_of(battle_id)
            .map(|e| CreatorEscrowView {
                creator: e.creator,
                representation: e.representation,
                amount: U128(e.amount),
                credited: false,
            })
    }

    /// Pays the creator escrow back after a cancel. The escrow is removed before the transfer; a failed
    /// transfer restores it in the callback, so a repeated call can never pay twice.
    #[payable]
    pub fn claim_lifecycle_escrow_refund(&mut self, battle_id: u64) -> Promise {
        near_sdk::assert_one_yocto();
        require!(
            self.lifecycle_is_cancelled(battle_id),
            "Battle is not cancelled"
        );
        let caller = env::predecessor_account_id();
        let escrow = self
            .lifecycle_creator_escrow_of(battle_id)
            .unwrap_or_else(|| env::panic_str("No creator escrow to refund"));
        require!(escrow.creator == caller, "Only the creator can claim it");
        let mut escrows = escrow_map();
        escrows.remove(&battle_id);
        escrows.flush();
        ext_ft::ext(escrow.representation.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(ESCROW_REFUND_TRANSFER_GAS)
            .ft_transfer(caller.clone(), U128(escrow.amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ESCROW_REFUND_CALLBACK_GAS)
                    .on_lifecycle_escrow_refund(
                        battle_id,
                        caller,
                        escrow.representation,
                        U128(escrow.amount),
                    ),
            )
    }

    /// Restores the escrow when the refund transfer failed.
    #[private]
    pub fn on_lifecycle_escrow_refund(
        &mut self,
        battle_id: u64,
        creator: AccountId,
        representation: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            events::emit(
                "lifecycle_creator_escrow_refunded",
                json!({ "battle_id": battle_id, "account_id": creator, "amount": amount }),
            );
            return true;
        }
        let mut escrows = escrow_map();
        escrows.insert(
            battle_id,
            CreatorEscrow {
                creator: creator.clone(),
                representation,
                amount: amount.0,
            },
        );
        escrows.flush();
        events::emit(
            "lifecycle_creator_escrow_refund_failed",
            json!({ "battle_id": battle_id, "account_id": creator, "amount": amount }),
        );
        false
    }
}

#[cfg(test)]
impl Arena {
    /// Unit-test helper that keeps the behavior of the removed `create_lifecycle_battle`: it creates an
    /// empty or pre-filled battle without any creator deposit and charges the attached NEAR. Production code
    /// cannot reach it; battles there come from `lifecycle_create_with_escrow`.
    pub(crate) fn create_lifecycle_battle_for_tests(
        &mut self,
        assets: Vec<crate::lifecycle::AssetInput>,
        mode: ScoringMode,
        start_at_ms: Option<near_sdk::json_types::U64>,
    ) -> u64 {
        require!(!self.paused, "Arena is paused");
        require!(self.lifecycle_exclusive, "Lifecycle is not activated");
        self.lifecycle_assert_mode_offered(mode);
        if let Some(start) = start_at_ms {
            Self::lifecycle_check_start(start.0);
        }
        require!(
            assets.iter().all(|asset| asset.representation != self.usdc),
            "USDC cannot be a lifecycle representation"
        );
        let creator = env::predecessor_account_id();
        let before = env::storage_usage();
        let assets: Vec<AssetIdentity> = assets.into_iter().map(Into::into).collect();
        let id = self.lifecycle_create_inner(&creator, assets, mode, start_at_ms.map(|s| s.0));
        self.charge_storage(before);
        events::emit(
            "lifecycle_battle_created",
            json!({ "battle_id": id, "creator": creator }),
        );
        id
    }
}
