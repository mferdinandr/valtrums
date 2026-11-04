use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

pub mod events;
pub mod math;
pub mod types;
pub mod views;

use types::{Battle, BattleStatus, NS_PER_SECOND};
use views::{BattleView, ConfigView};

/// Longest battle a proposer can request.
const MAX_DURATION_SECS: u64 = 30 * 24 * 60 * 60;
/// Gas for the USDC transfer out to the treasury and its callback.
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(10);
const CALLBACK_GAS: Gas = Gas::from_tgas(5);
/// Most battles `get_battles` returns in one call.
const MAX_PAGE_SIZE: u64 = 100;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Agents,
    Battles,
}

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

/// Messages accepted through `ft_transfer_call`.
#[near(serializers = [json])]
#[serde(tag = "action", rename_all = "snake_case")]
enum TransferMsg {
    Propose {
        token_a: AccountId,
        token_b: AccountId,
        duration_secs: u64,
    },
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
    battles: LookupMap<u64, Battle>,
    battle_count: u64,
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
            battles: LookupMap::new(StorageKey::Battles),
            battle_count: 0,
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

    // ─── Agent: audit decision ──────────────────────────────────────────

    /// Audit passed: opens the deposit window.
    pub fn approve_battle(&mut self, battle_id: u64) {
        self.assert_agent();
        let window_ns = self.deposit_window_secs * NS_PER_SECOND;
        let battle = self.battle_in_status(battle_id, BattleStatus::Proposed);
        let deadline = env::block_timestamp() + window_ns;
        battle.status = BattleStatus::Approved;
        battle.deposit_deadline_ns = deadline;
        events::emit(
            "battle_approved",
            json!({ "battle_id": battle_id, "deposit_deadline_ns": U64(deadline) }),
        );
    }

    /// Audit failed: the proposal is cancelled and the bond is seized.
    pub fn void_battle(&mut self, battle_id: u64, reason: String) {
        self.assert_agent();
        let battle = self.battle_in_status(battle_id, BattleStatus::Proposed);
        battle.status = BattleStatus::Voided;
        let bond = battle.bond;
        self.accrue_treasury(bond);
        events::emit(
            "battle_voided",
            json!({ "battle_id": battle_id, "reason": reason, "bond_seized": U128(bond) }),
        );
    }

    // ─── Treasury ───────────────────────────────────────────────────────

    /// Pays accrued USDC to the treasury. Anyone may call; the destination is fixed.
    pub fn flush_treasury(&mut self) -> Promise {
        let amount = self.treasury_accrued;
        require!(amount > 0, "Nothing to flush");
        self.treasury_accrued = 0;
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(self.treasury.clone(), U128(amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_treasury_flushed(U128(amount)),
            )
    }

    /// Restores the accrued amount if the transfer failed, so funds are never lost.
    #[private]
    pub fn on_treasury_flushed(
        &mut self,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            self.accrue_treasury(amount.0);
            events::emit("treasury_flush_failed", json!({ "amount": amount }));
        } else {
            events::emit("treasury_flushed", json!({ "amount": amount }));
        }
    }

    // ─── Token receiver ─────────────────────────────────────────────────

    /// NEP-141 receiver. USDC with a `propose` message creates a battle and
    /// keeps the bond; anything unexpected is returned in full.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        if self.paused || token != self.usdc {
            return PromiseOrValue::Value(amount);
        }
        let unused = match serde_json::from_str::<TransferMsg>(&msg) {
            Ok(TransferMsg::Propose {
                token_a,
                token_b,
                duration_secs,
            }) => self.handle_propose(sender_id, amount.0, token_a, token_b, duration_secs),
            Err(_) => amount.0,
        };
        PromiseOrValue::Value(U128(unused))
    }

    // ─── Views ──────────────────────────────────────────────────────────

    pub fn get_battle(&self, battle_id: u64) -> Option<BattleView> {
        self.battles
            .get(&battle_id)
            .map(|battle| BattleView::new(battle_id, battle))
    }

    pub fn get_battle_count(&self) -> u64 {
        self.battle_count
    }

    /// Battles in ascending id order. `from_index` is a zero-based offset.
    pub fn get_battles(&self, from_index: u64, limit: u64) -> Vec<BattleView> {
        let limit = limit.min(MAX_PAGE_SIZE);
        (from_index.saturating_add(1)..=self.battle_count)
            .take(limit as usize)
            .filter_map(|id| self.get_battle(id))
            .collect()
    }

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
    fn accrue_treasury(&mut self, amount: u128) {
        self.treasury_accrued = self
            .treasury_accrued
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("Treasury overflow"));
    }

    /// Loads a battle and requires it to be in `expected`.
    fn battle_in_status(&mut self, battle_id: u64, expected: BattleStatus) -> &mut Battle {
        let battle = self
            .battles
            .get_mut(&battle_id)
            .unwrap_or_else(|| env::panic_str("Battle not found"));
        require!(
            battle.status == expected,
            "Battle is not in the required status"
        );
        battle
    }

    fn handle_propose(
        &mut self,
        creator: AccountId,
        amount: u128,
        token_a: AccountId,
        token_b: AccountId,
        duration_secs: u64,
    ) -> u128 {
        let invalid_tokens = token_a == token_b || token_a == self.usdc || token_b == self.usdc;
        let invalid_duration = duration_secs == 0 || duration_secs > MAX_DURATION_SECS;
        if invalid_tokens || invalid_duration || amount < self.bond {
            return amount;
        }

        let battle_id = self
            .battle_count
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Battle id overflow"));
        self.battle_count = battle_id;
        self.battles.insert(
            battle_id,
            Battle {
                creator: creator.clone(),
                token_a: token_a.clone(),
                token_b: token_b.clone(),
                bond: self.bond,
                duration_ns: duration_secs * NS_PER_SECOND,
                deposit_deadline_ns: 0,
                status: BattleStatus::Proposed,
                vault_a: 0,
                vault_b: 0,
                start_time_ns: 0,
                end_time_ns: 0,
                initial_price_a: None,
                initial_price_b: None,
                final_price_a: None,
                final_price_b: None,
                winner: None,
            },
        );
        events::emit(
            "battle_proposed",
            json!({
                "battle_id": battle_id,
                "creator": creator,
                "token_a": token_a,
                "token_b": token_b,
                "bond": U128(self.bond),
            }),
        );
        amount - self.bond
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Only the owner can call this method"
        );
    }

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

    fn propose_msg(token_a: &str, token_b: &str, duration_secs: u64) -> String {
        json!({
            "action": "propose",
            "token_a": acc(token_a),
            "token_b": acc(token_b),
            "duration_secs": duration_secs,
        })
        .to_string()
    }

    fn returned(result: PromiseOrValue<U128>) -> u128 {
        match result {
            PromiseOrValue::Value(v) => v.0,
            PromiseOrValue::Promise(_) => panic!("expected an immediate value"),
        }
    }

    fn propose(arena: &mut Arena, sender: &str, amount: u128, msg: String) -> u128 {
        set_context("usdc", 0);
        returned(arena.ft_on_transfer(acc(sender), U128(amount), msg))
    }

    #[test]
    fn valid_proposal_creates_battle_and_keeps_bond() {
        let mut arena = new_arena();
        let unused = propose(
            &mut arena,
            "alice",
            5_000_000,
            propose_msg("pepe", "shib", 86_400),
        );
        assert_eq!(unused, 0);
        assert_eq!(arena.get_battle_count(), 1);

        let battle = arena.get_battle(1).unwrap();
        assert_eq!(battle.creator, acc("alice"));
        assert_eq!(battle.token_a, acc("pepe"));
        assert_eq!(battle.token_b, acc("shib"));
        assert_eq!(battle.status, BattleStatus::Proposed);
        assert_eq!(battle.bond, U128(5_000_000));
        assert_eq!(battle.duration_ns, U64(86_400 * NS_PER_SECOND));
        assert_eq!(battle.deposit_deadline_ns, U64(0));
        assert!(battle.initial_price_a.is_none());
    }

    #[test]
    fn proposal_emits_event() {
        let mut arena = new_arena();
        propose(
            &mut arena,
            "alice",
            5_000_000,
            propose_msg("pepe", "shib", 60),
        );
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs
            .iter()
            .any(|l| l.contains("\"event\":\"battle_proposed\"")));
    }

    #[test]
    fn excess_bond_is_returned() {
        let mut arena = new_arena();
        let unused = propose(
            &mut arena,
            "alice",
            8_000_000,
            propose_msg("pepe", "shib", 60),
        );
        assert_eq!(unused, 3_000_000);
        assert_eq!(arena.get_battle_count(), 1);
    }

    #[test]
    fn insufficient_bond_is_returned_in_full() {
        let mut arena = new_arena();
        let unused = propose(
            &mut arena,
            "alice",
            4_999_999,
            propose_msg("pepe", "shib", 60),
        );
        assert_eq!(unused, 4_999_999);
        assert_eq!(arena.get_battle_count(), 0);
    }

    #[test]
    fn identical_tokens_are_returned_in_full() {
        let mut arena = new_arena();
        let unused = propose(
            &mut arena,
            "alice",
            5_000_000,
            propose_msg("pepe", "pepe", 60),
        );
        assert_eq!(unused, 5_000_000);
        assert_eq!(arena.get_battle_count(), 0);
    }

    #[test]
    fn usdc_cannot_be_a_battle_token() {
        let mut arena = new_arena();
        let unused = propose(
            &mut arena,
            "alice",
            5_000_000,
            propose_msg("usdc", "shib", 60),
        );
        assert_eq!(unused, 5_000_000);
        assert_eq!(arena.get_battle_count(), 0);
    }

    #[test]
    fn invalid_duration_is_returned_in_full() {
        let mut arena = new_arena();
        assert_eq!(
            propose(
                &mut arena,
                "alice",
                5_000_000,
                propose_msg("pepe", "shib", 0)
            ),
            5_000_000
        );
        assert_eq!(
            propose(
                &mut arena,
                "alice",
                5_000_000,
                propose_msg("pepe", "shib", MAX_DURATION_SECS + 1)
            ),
            5_000_000
        );
        assert_eq!(arena.get_battle_count(), 0);
    }

    #[test]
    fn malformed_message_is_returned_in_full() {
        let mut arena = new_arena();
        assert_eq!(propose(&mut arena, "alice", 7, "not json".to_string()), 7);
        assert_eq!(
            propose(
                &mut arena,
                "alice",
                7,
                json!({"action": "unknown"}).to_string()
            ),
            7
        );
        assert_eq!(arena.get_battle_count(), 0);
    }

    #[test]
    fn unexpected_token_is_returned_in_full() {
        let mut arena = new_arena();
        set_context("scam", 0);
        let result = arena.ft_on_transfer(
            acc("alice"),
            U128(5_000_000),
            propose_msg("pepe", "shib", 60),
        );
        assert_eq!(returned(result), 5_000_000);
        assert_eq!(arena.get_battle_count(), 0);
    }

    #[test]
    fn paused_contract_returns_proposals() {
        let mut arena = new_arena();
        arena.set_paused(true);
        let unused = propose(
            &mut arena,
            "alice",
            5_000_000,
            propose_msg("pepe", "shib", 60),
        );
        assert_eq!(unused, 5_000_000);
        assert_eq!(arena.get_battle_count(), 0);
    }

    #[test]
    fn battles_are_paginated_in_ascending_order() {
        let mut arena = new_arena();
        for _ in 0..5 {
            propose(
                &mut arena,
                "alice",
                5_000_000,
                propose_msg("pepe", "shib", 60),
            );
        }
        let ids = |from, limit| -> Vec<u64> {
            arena
                .get_battles(from, limit)
                .iter()
                .map(|b| b.id)
                .collect()
        };
        assert_eq!(ids(0, 100), vec![1, 2, 3, 4, 5]);
        assert_eq!(ids(1, 2), vec![2, 3]);
        assert_eq!(ids(4, 10), vec![5]);
        assert!(ids(5, 10).is_empty());
        assert!(arena.get_battle(6).is_none());
    }

    fn arena_with_proposal() -> Arena {
        let mut arena = new_arena();
        arena.add_agent(acc("agent"));
        propose(
            &mut arena,
            "alice",
            5_000_000,
            propose_msg("pepe", "shib", 86_400),
        );
        arena
    }

    #[test]
    fn agent_approval_opens_deposit_window() {
        let mut arena = arena_with_proposal();
        set_context("agent", 1_000);
        arena.approve_battle(1);
        let battle = arena.get_battle(1).unwrap();
        assert_eq!(battle.status, BattleStatus::Approved);
        assert_eq!(
            battle.deposit_deadline_ns,
            U64(1_000 + 3_600 * NS_PER_SECOND)
        );
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs
            .iter()
            .any(|l| l.contains("\"event\":\"battle_approved\"")));
    }

    #[test]
    #[should_panic(expected = "Only a whitelisted agent")]
    fn only_agents_approve() {
        let mut arena = arena_with_proposal();
        set_context("alice", 0);
        arena.approve_battle(1);
    }

    #[test]
    #[should_panic(expected = "Battle is not in the required status")]
    fn cannot_approve_twice() {
        let mut arena = arena_with_proposal();
        set_context("agent", 0);
        arena.approve_battle(1);
        arena.approve_battle(1);
    }

    #[test]
    #[should_panic(expected = "Battle not found")]
    fn cannot_approve_unknown_battle() {
        let mut arena = arena_with_proposal();
        set_context("agent", 0);
        arena.approve_battle(99);
    }

    #[test]
    fn void_seizes_bond_for_the_treasury() {
        let mut arena = arena_with_proposal();
        set_context("agent", 0);
        arena.void_battle(1, "low liquidity".to_string());
        let battle = arena.get_battle(1).unwrap();
        assert_eq!(battle.status, BattleStatus::Voided);
        assert_eq!(arena.get_config().treasury_accrued, U128(5_000_000));
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs.iter().any(|l| l.contains("low liquidity")));
    }

    #[test]
    #[should_panic(expected = "Only a whitelisted agent")]
    fn only_agents_void() {
        let mut arena = arena_with_proposal();
        set_context("alice", 0);
        arena.void_battle(1, "x".to_string());
    }

    #[test]
    #[should_panic(expected = "Battle is not in the required status")]
    fn cannot_void_an_approved_battle() {
        let mut arena = arena_with_proposal();
        set_context("agent", 0);
        arena.approve_battle(1);
        arena.void_battle(1, "late".to_string());
    }

    #[test]
    #[should_panic(expected = "Battle is not in the required status")]
    fn cannot_approve_a_voided_battle() {
        let mut arena = arena_with_proposal();
        set_context("agent", 0);
        arena.void_battle(1, "honeypot".to_string());
        arena.approve_battle(1);
    }

    #[test]
    fn agents_keep_working_while_paused() {
        let mut arena = arena_with_proposal();
        set_context("owner", 0);
        arena.set_paused(true);
        set_context("agent", 0);
        arena.approve_battle(1);
        assert_eq!(arena.get_battle(1).unwrap().status, BattleStatus::Approved);
    }

    #[test]
    fn flush_clears_accrual_and_failed_transfer_restores_it() {
        let mut arena = arena_with_proposal();
        set_context("agent", 0);
        arena.void_battle(1, "honeypot".to_string());

        set_context("anyone", 0);
        let _ = arena.flush_treasury();
        assert_eq!(arena.get_config().treasury_accrued, U128(0));

        arena.on_treasury_flushed(U128(5_000_000), Err(PromiseError::Failed));
        assert_eq!(arena.get_config().treasury_accrued, U128(5_000_000));
    }

    #[test]
    fn successful_flush_leaves_accrual_at_zero() {
        let mut arena = arena_with_proposal();
        set_context("agent", 0);
        arena.void_battle(1, "honeypot".to_string());
        set_context("anyone", 0);
        let _ = arena.flush_treasury();
        arena.on_treasury_flushed(U128(5_000_000), Ok(()));
        assert_eq!(arena.get_config().treasury_accrued, U128(0));
    }

    #[test]
    #[should_panic(expected = "Nothing to flush")]
    fn flush_requires_accrued_funds() {
        let mut arena = new_arena();
        let _ = arena.flush_treasury();
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn non_owner_cannot_pause() {
        let mut arena = new_arena();
        set_context("stranger", 0);
        arena.set_paused(true);
    }
}
