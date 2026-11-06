//! Multi-community lifecycle for fresh deployments; representations must be registered by owner.
use crate::{
    events,
    v2_revenue::RevenuePolicy,
    v2_scoring::{select_leaders, Mode, Observation, Window, ROUND_DURATION_NS},
    Arena, ArenaExt,
};
use near_sdk::json_types::U64;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId};

#[near(serializers=[borsh])]
pub struct State {
    battles: LookupMap<u64, Battle>,
    positions: LookupMap<(u64, AccountId), Position>,
    assets: LookupMap<AccountId, String>,
    sources: LookupMap<String, AccountId>,
    count: u64,
}
impl Default for State {
    fn default() -> Self {
        Self {
            battles: LookupMap::new(b"v2:bat".to_vec()),
            positions: LookupMap::new(b"v2:pos".to_vec()),
            assets: LookupMap::new(b"v2:assets".to_vec()),
            sources: LookupMap::new(b"v2:sources".to_vec()),
            count: 0,
        }
    }
}
#[near(serializers=[borsh])]
#[derive(Clone)]
struct Position {
    community: u32,
    amount: u128,
}
#[near(serializers=[borsh])]
#[derive(Clone)]
struct Battle {
    creator: AccountId,
    communities: Vec<AccountId>,
    vaults: Vec<u128>,
    mode: Mode,
    deadline: u64,
    policy: RevenuePolicy,
    policy_hash: String,
    approved_until: Vec<u64>,
    round: u64,
    start: u64,
    end: u64,
    candidates: Vec<u32>,
    winner: Option<u32>,
    sample_gap: u64,
}

#[near]
impl Arena {
    /// Registry binds a verified wrapper to its immutable Robinhood source identity.
    pub fn register_asset_v2(&mut self, token: AccountId, source_address: String) {
        self.assert_owner();
        require!(
            source_address.len() == 42
                && source_address.starts_with("0x")
                && source_address[2..].bytes().all(|b| b.is_ascii_hexdigit()),
            "Invalid source address"
        );
        require!(
            source_address[2..].bytes().any(|b| b != b'0'),
            "Zero source address"
        );
        let source = source_address.to_ascii_lowercase();
        if let Some(existing) = self.v2_lifecycle.assets.get(&token) {
            require!(existing == &source, "Immutable asset mapping");
            return;
        }
        require!(
            !self.v2_lifecycle.sources.contains_key(&source),
            "Source already represented"
        );
        self.v2_lifecycle
            .sources
            .insert(source.clone(), token.clone());
        self.v2_lifecycle.assets.insert(token, source);
    }
    /// No bond. Storage sponsorship must be funded before public deployment.
    pub fn create_battle_v2(
        &mut self,
        communities: Vec<AccountId>,
        mode: Mode,
        deadline_ns: U64,
        observation_policy_hash: String,
        max_sample_gap_ns: U64,
    ) -> U64 {
        require!(!self.paused, "Paused");
        require!(
            communities.len() >= 2 && communities.len() <= 32,
            "Require 2 to 32 communities per snapshot"
        );
        let unique: std::collections::BTreeSet<_> = communities.iter().collect();
        require!(unique.len() == communities.len(), "Duplicate community");
        require!(
            communities
                .iter()
                .all(|t| self.v2_lifecycle.assets.contains_key(t)),
            "Unregistered representation"
        );
        require!(
            deadline_ns.0 > env::block_timestamp(),
            "Deadline must be future"
        );
        require!(
            !observation_policy_hash.is_empty() && observation_policy_hash.len() <= 128,
            "Policy hash required"
        );
        require!(
            max_sample_gap_ns.0 > 0 && max_sample_gap_ns.0 <= ROUND_DURATION_NS,
            "Invalid sampling policy"
        );
        let id = self
            .v2_lifecycle
            .count
            .checked_add(1)
            .expect("Battle counter overflow");
        let count = communities.len();
        let battle = Battle {
            creator: env::predecessor_account_id(),
            communities,
            vaults: vec![0; count],
            mode,
            deadline: deadline_ns.0,
            policy: self.v2_revenue,
            policy_hash: observation_policy_hash,
            approved_until: vec![0; count],
            round: 0,
            start: 0,
            end: 0,
            candidates: (0..count as u32).collect(),
            winner: None,
            sample_gap: max_sample_gap_ns.0,
        };
        self.v2_lifecycle.battles.insert(id, battle);
        self.v2_lifecycle.count = id;
        events::emit(
            "battle_v2_created",
            json!({"battle_id":U64(id),"creator":env::predecessor_account_id(),"revenue_policy_version":U64(self.v2_revenue.version)}),
        );
        U64(id)
    }
    pub fn record_audit_v2(
        &mut self,
        battle_id: U64,
        community: u32,
        policy_hash: String,
        valid_until_ns: U64,
    ) {
        self.assert_agent();
        let battle = self
            .v2_lifecycle
            .battles
            .get_mut(&battle_id.0)
            .expect("Unknown battle");
        require!(battle.round == 0, "Already locked");
        require!(
            policy_hash == battle.policy_hash && valid_until_ns.0 > env::block_timestamp(),
            "Invalid audit evidence"
        );
        let approval = battle
            .approved_until
            .get_mut(community as usize)
            .expect("Unknown community");
        *approval = valid_until_ns.0;
    }
    pub fn lock_battle_v2(&mut self, battle_id: U64) {
        self.assert_agent();
        let mut battle = self
            .v2_lifecycle
            .battles
            .get(&battle_id.0)
            .expect("Unknown battle")
            .clone();
        if battle.round > 0 {
            return;
        }
        let now = env::block_timestamp();
        require!(now >= battle.deadline, "Gathering still open");
        require!(battle.vaults.iter().all(|n| *n > 0), "Empty community");
        require!(
            battle.approved_until.iter().all(|until| *until > now),
            "Fresh audit required"
        );
        require!(
            self.v2_lifecycle
                .positions
                .contains_key(&(battle_id.0, battle.creator.clone())),
            "Creator must participate"
        );
        battle.round = 1;
        battle.start = now;
        battle.end = now.checked_add(ROUND_DURATION_NS).expect("Time overflow");
        self.v2_lifecycle.battles.insert(battle_id.0, battle);
        events::emit("battle_v2_locked", json!({"battle_id":battle_id}));
    }
    pub fn resolve_round_v2(
        &mut self,
        battle_id: U64,
        round: U64,
        policy_hash: String,
        observations: Vec<Observation>,
    ) {
        self.assert_agent();
        let mut battle = self
            .v2_lifecycle
            .battles
            .get(&battle_id.0)
            .expect("Unknown battle")
            .clone();
        require!(
            battle.round == round.0 && battle.round > 0 && battle.winner.is_none(),
            "Invalid round state"
        );
        require!(env::block_timestamp() >= battle.end, "Round still live");
        require!(policy_hash == battle.policy_hash, "Policy mismatch");
        let ids: std::collections::BTreeSet<_> =
            observations.iter().map(|o| o.community_id).collect();
        require!(
            observations.len() == battle.candidates.len()
                && ids == battle.candidates.iter().copied().collect(),
            "Candidate evidence mismatch"
        );
        let result = select_leaders(
            battle.mode,
            &observations,
            &Window {
                start_ns: U64(battle.start),
                end_ns: U64(battle.end),
                max_sample_gap_ns: U64(battle.sample_gap),
            },
        )
        .expect("Invalid scoring evidence");
        if result.leaders.len() == 1 {
            battle.winner = Some(result.leaders[0]);
        } else {
            battle.candidates = result.leaders.clone();
            battle.round = battle.round.checked_add(1).expect("Round overflow");
            battle.start = battle.end;
            battle.end = battle
                .end
                .checked_add(ROUND_DURATION_NS)
                .expect("Time overflow");
        }
        self.v2_lifecycle.battles.insert(battle_id.0, battle);
        events::emit(
            "battle_v2_round_resolved",
            json!({"battle_id":battle_id,"round":round,"result":result}),
        );
    }
    pub fn get_battle_v2(&self, battle_id: U64) -> Option<Value> {
        self.v2_lifecycle.battles.get(&battle_id.0).map(|b|json!({"id":battle_id,"creator":b.creator,"communities":b.communities,"vaults":b.vaults.iter().map(|n|n.to_string()).collect::<Vec<_>>(),"mode":b.mode,"deadline_ns":U64(b.deadline),"revenue_policy_version":U64(b.policy.version),"total_fee_bps":b.policy.total_fee_bps,"creator_share_bps":b.policy.creator_share_bps,"round":U64(b.round),"start_ns":U64(b.start),"end_ns":U64(b.end),"candidates":b.candidates,"winner":b.winner}))
    }
}
impl Arena {
    pub(crate) fn deposit_v2(
        &mut self,
        sender: AccountId,
        token: AccountId,
        amount: u128,
        id: u64,
    ) -> u128 {
        let Some(mut battle) = self.v2_lifecycle.battles.get(&id).cloned() else {
            return amount;
        };
        let now = env::block_timestamp();
        if amount == 0 || battle.round > 0 || now >= battle.deadline {
            return amount;
        }
        let Some(index) = battle.communities.iter().position(|t| t == &token) else {
            return amount;
        };
        if battle.approved_until[index] <= now {
            return amount;
        }
        let key = (id, sender);
        let old = self.v2_lifecycle.positions.get(&key).cloned();
        if old.as_ref().is_some_and(|p| p.community != index as u32) {
            return amount;
        }
        let Some(total) = old.map_or(0, |p| p.amount).checked_add(amount) else {
            return amount;
        };
        let Some(vault) = battle.vaults[index].checked_add(amount) else {
            return amount;
        };
        battle.vaults[index] = vault;
        self.v2_lifecycle.positions.insert(
            key,
            Position {
                community: index as u32,
                amount: total,
            },
        );
        self.v2_lifecycle.battles.insert(id, battle);
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::json_types::U128;
    use near_sdk::{test_utils::VMContextBuilder, testing_env};
    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn context(who: &str, time: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("arena.testnet"))
            .predecessor_account_id(acc(who))
            .block_timestamp(time)
            .build());
    }
    fn setup() -> Arena {
        context("owner.testnet", 0);
        let mut arena = Arena::new(
            acc("owner.testnet"),
            acc("usdc.testnet"),
            acc("treasury.testnet"),
            U128(1),
            U64(300),
        );
        arena.add_agent(acc("oracle.testnet"));
        for (token, byte) in [
            ("a.testnet", "11"),
            ("b.testnet", "22"),
            ("c.testnet", "33"),
        ] {
            arena.register_asset_v2(acc(token), format!("0x{}", byte.repeat(20)));
        }
        arena
    }
    fn create(arena: &mut Arena) -> U64 {
        context("alice.testnet", 1);
        arena.create_battle_v2(
            vec![acc("a.testnet"), acc("b.testnet"), acc("c.testnet")],
            Mode::PricePercentGain,
            U64(10),
            "policy".into(),
            U64(1_000_000_000),
        )
    }
    fn approved(arena: &mut Arena, id: U64) {
        context("oracle.testnet", 2);
        for i in 0..3 {
            arena.record_audit_v2(id, i, "policy".into(), U64(100_000_000_000));
        }
    }
    #[test]
    fn snapshots_revenue_at_creation_and_accepts_three_communities() {
        let mut arena = setup();
        let id = create(&mut arena);
        context("owner.testnet", 2);
        arena.set_revenue_policy(200, 2500);
        let view = arena.get_battle_v2(id).unwrap();
        assert_eq!(view["total_fee_bps"], 10);
        assert_eq!(view["creator_share_bps"], 5000);
        assert_eq!(view["communities"].as_array().unwrap().len(), 3);
    }
    #[test]
    fn deposits_require_audit_and_refund_wrong_side_or_late_arrival() {
        let mut arena = setup();
        let id = create(&mut arena);
        assert_eq!(
            arena.deposit_v2(acc("alice.testnet"), acc("a.testnet"), 10, id.0),
            10
        );
        approved(&mut arena, id);
        assert_eq!(
            arena.deposit_v2(acc("alice.testnet"), acc("a.testnet"), 10, id.0),
            0
        );
        assert_eq!(
            arena.deposit_v2(acc("alice.testnet"), acc("b.testnet"), 10, id.0),
            10
        );
        context("oracle.testnet", 10);
        assert_eq!(
            arena.deposit_v2(acc("bob.testnet"), acc("b.testnet"), 10, id.0),
            10
        );
    }
    #[test]
    fn lock_is_idempotent_and_deposits_stay_closed() {
        let mut arena = setup();
        let id = create(&mut arena);
        approved(&mut arena, id);
        for (who, token) in [
            ("alice.testnet", "a.testnet"),
            ("bob.testnet", "b.testnet"),
            ("carol.testnet", "c.testnet"),
        ] {
            assert_eq!(arena.deposit_v2(acc(who), acc(token), 100, id.0), 0);
        }
        context("oracle.testnet", 10);
        arena.lock_battle_v2(id);
        let first = arena.get_battle_v2(id).unwrap();
        context("oracle.testnet", 20);
        arena.lock_battle_v2(id);
        assert_eq!(arena.get_battle_v2(id).unwrap(), first);
        assert_eq!(
            arena.deposit_v2(acc("alice.testnet"), acc("a.testnet"), 100, id.0),
            100
        );
    }
    #[test]
    #[should_panic(expected = "Creator must participate")]
    fn no_creator_position_prevents_lock() {
        let mut arena = setup();
        let id = create(&mut arena);
        approved(&mut arena, id);
        for (who, token) in [
            ("bob.testnet", "a.testnet"),
            ("carol.testnet", "b.testnet"),
            ("dave.testnet", "c.testnet"),
        ] {
            arena.deposit_v2(acc(who), acc(token), 1, id.0);
        }
        context("oracle.testnet", 10);
        arena.lock_battle_v2(id);
    }
}
