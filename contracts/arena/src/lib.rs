use near_sdk::json_types::{U128, U64};
use near_sdk::store::IterableSet;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

pub mod events;
pub mod math;
pub mod types;
pub mod views;

use views::ConfigView;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Agents,
}

/// Battle arena contract: battle lifecycle, vaults, positions and settlement.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Arena {
    owner: AccountId,
    usdc: AccountId,
    treasury: AccountId,
    /// Bond (USDC base units) paid when proposing a battle.
    bond: u128,
    /// How long deposits stay open after the agent approves a battle.
    deposit_window_secs: u64,
    agents: IterableSet<AccountId>,
    paused: bool,
    /// USDC owed to the treasury, paid out by `flush_treasury`.
    treasury_accrued: u128,
}

#[near]
impl Arena {
    #[init]
    pub fn new(
        owner: AccountId,
        usdc: AccountId,
        treasury: AccountId,
        bond: U128,
        deposit_window_secs: U64,
    ) -> Self {
        require!(deposit_window_secs.0 > 0, "Deposit window must be positive");
        Self {
            owner,
            usdc,
            treasury,
            bond: bond.0,
            deposit_window_secs: deposit_window_secs.0,
            agents: IterableSet::new(StorageKey::Agents),
            paused: false,
            treasury_accrued: 0,
        }
    }

    // ─── Owner configuration ────────────────────────────────────────────

    pub fn add_agent(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.agents.insert(account_id);
    }

    pub fn remove_agent(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.agents.remove(&account_id);
    }

    pub fn set_treasury(&mut self, treasury: AccountId) {
        self.assert_owner();
        self.treasury = treasury;
    }

    pub fn set_bond(&mut self, bond: U128) {
        self.assert_owner();
        self.bond = bond.0;
    }

    pub fn set_deposit_window_secs(&mut self, secs: U64) {
        self.assert_owner();
        require!(secs.0 > 0, "Deposit window must be positive");
        self.deposit_window_secs = secs.0;
    }

    /// Pauses new proposals and deposits. Refunds and claims stay available.
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    // ─── Views ──────────────────────────────────────────────────────────

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            usdc: self.usdc.clone(),
            treasury: self.treasury.clone(),
            bond: U128(self.bond),
            deposit_window_secs: U64(self.deposit_window_secs),
            agents: self.agents.iter().cloned().collect(),
            paused: self.paused,
            treasury_accrued: U128(self.treasury_accrued),
        }
    }
}

impl Arena {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Only the owner can call this method"
        );
    }

    #[allow(dead_code)]
    fn assert_agent(&self) {
        require!(
            self.agents.contains(&env::predecessor_account_id()),
            "Only a whitelisted agent can call this method"
        );
    }
}

#[cfg(test)]
pub(crate) mod test_helpers {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    pub fn acc(name: &str) -> AccountId {
        format!("{name}.testnet").parse().unwrap()
    }

    pub fn set_context(predecessor: &str, timestamp_ns: u64) {
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(acc(predecessor))
            .block_timestamp(timestamp_ns)
            .build();
        testing_env!(ctx);
    }

    pub fn new_arena() -> Arena {
        set_context("owner", 0);
        Arena::new(
            acc("owner"),
            acc("usdc"),
            acc("treasury"),
            U128(5_000_000),
            U64(3_600),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::test_helpers::*;
    use super::*;

    #[test]
    fn init_stores_config() {
        let arena = new_arena();
        let config = arena.get_config();
        assert_eq!(config.owner, acc("owner"));
        assert_eq!(config.usdc, acc("usdc"));
        assert_eq!(config.treasury, acc("treasury"));
        assert_eq!(config.bond, U128(5_000_000));
        assert_eq!(config.deposit_window_secs, U64(3_600));
        assert!(config.agents.is_empty());
        assert!(!config.paused);
        assert_eq!(config.treasury_accrued, U128(0));
    }

    #[test]
    #[should_panic(expected = "Deposit window must be positive")]
    fn init_rejects_zero_window() {
        set_context("owner", 0);
        Arena::new(acc("owner"), acc("usdc"), acc("treasury"), U128(1), U64(0));
    }

    #[test]
    fn owner_rotates_agents() {
        let mut arena = new_arena();
        arena.add_agent(acc("agent1"));
        assert_eq!(arena.get_config().agents, vec![acc("agent1")]);

        arena.remove_agent(acc("agent1"));
        arena.add_agent(acc("agent2"));
        assert_eq!(arena.get_config().agents, vec![acc("agent2")]);

        set_context("agent2", 0);
        arena.assert_agent();
    }

    #[test]
    #[should_panic(expected = "Only a whitelisted agent")]
    fn removed_agent_loses_access() {
        let mut arena = new_arena();
        arena.add_agent(acc("agent1"));
        arena.remove_agent(acc("agent1"));
        set_context("agent1", 0);
        arena.assert_agent();
    }

    #[test]
    #[should_panic(expected = "Only a whitelisted agent")]
    fn stranger_is_not_an_agent() {
        let arena = new_arena();
        set_context("stranger", 0);
        arena.assert_agent();
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn non_owner_cannot_add_agent() {
        let mut arena = new_arena();
        set_context("stranger", 0);
        arena.add_agent(acc("stranger"));
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn non_owner_cannot_change_treasury() {
        let mut arena = new_arena();
        set_context("stranger", 0);
        arena.set_treasury(acc("stranger"));
    }

    #[test]
    fn owner_updates_config() {
        let mut arena = new_arena();
        arena.set_treasury(acc("treasury2"));
        arena.set_bond(U128(9));
        arena.set_deposit_window_secs(U64(60));
        arena.set_paused(true);
        let config = arena.get_config();
        assert_eq!(config.treasury, acc("treasury2"));
        assert_eq!(config.bond, U128(9));
        assert_eq!(config.deposit_window_secs, U64(60));
        assert!(config.paused);
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn non_owner_cannot_pause() {
        let mut arena = new_arena();
        set_context("stranger", 0);
        arena.set_paused(true);
    }
}
