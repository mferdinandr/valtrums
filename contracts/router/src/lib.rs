//! Swap router: turns a USDC deposit into the side's meme coin through a DEX
//! and deposits the coin into the arena. The router never keeps user funds:
//! every hop either fully succeeds or hands the amount back to the sender.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

pub mod events;
pub mod types;

use types::{ConfigView, PendingSwap};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Pending,
    Stranded,
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
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Only the owner can call this method"
        );
    }
}

#[cfg(test)]
mod tests;
