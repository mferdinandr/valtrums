//! Sandbox stand-in for the arena's `get_lifecycle_battle` view, so backing's
//! lock query can be tested. Anyone can set a battle; never deploy.

use near_sdk::json_types::U64;
use near_sdk::store::LookupMap;
use near_sdk::{near, BorshStorageKey, PanicOnDefault};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Battles,
}

#[near(serializers = [json])]
pub struct BattleView {
    pub locked: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockLifecycle {
    battles: LookupMap<u64, bool>,
}

#[near]
impl MockLifecycle {
    #[init]
    pub fn new() -> Self {
        Self {
            battles: LookupMap::new(StorageKey::Battles),
        }
    }

    /// Fixture only: create or update a battle's lock state.
    pub fn set_battle(&mut self, battle_id: U64, locked: bool) {
        self.battles.insert(battle_id.0, locked);
    }

    pub fn get_lifecycle_battle(&self, battle_id: u64) -> Option<BattleView> {
        self.battles
            .get(&battle_id)
            .map(|locked| BattleView { locked: *locked })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_battles_are_absent_and_locks_are_reported() {
        let mut mock = MockLifecycle::new();
        assert!(mock.get_lifecycle_battle(1).is_none());
        mock.set_battle(U64(1), false);
        assert!(mock.get_lifecycle_battle(1).is_some_and(|b| !b.locked));
        mock.set_battle(U64(1), true);
        assert!(mock.get_lifecycle_battle(1).is_some_and(|b| b.locked));
    }
}
