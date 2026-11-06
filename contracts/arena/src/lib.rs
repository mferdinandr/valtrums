//! The permissionless multi-community arena (docs/product-spec.md).
//!
//! Two or more token communities compete in 30-second point-observation
//! rounds. The creator selects one of four exact scoring modes; tied leaders
//! repeat with reset inputs without a cap; all original vaults stay locked
//! until a unique winner. Each losing vault pays 99.9% to winning
//! participants as original-token entitlements, 0.05% to the creator and
//! 0.05% to the protocol (all 0.1% to the protocol for protocol-created
//! battles). Winning principal enters DAO escrow; disposition is
//! decision-bound and DAO governance stays OPEN.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, IterableSet, LookupMap, LookupSet};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

pub mod audit;
pub mod events;
pub mod grants;
pub mod mpc;
pub mod scoring;
pub mod settlement;
pub mod types;
pub mod views;

use audit::{evaluate_audit, AuditDecision};
use mpc::{ForeignConfig, ForeignConfigInput, SignRequest, SignStatus};
use scoring::{best_is_highest, max_drawdown, market_cap_growth, price_gain, volume_ratio, Score};
use settlement::{distribute_winner_pool, split_loser_vault};
use types::{
    Battle, BattleStatus, Community, DaoDecision, DaoEscrow, DisposalKind, EscrowStatus, Grant,
    PolicyRef, RoundEvidence, ScoringMode, TokenIdentity, NS_PER_SECOND, ROUND_SECS,
};
use views::{BattleView, ConfigView, PositionView, RoundView};

/// Gas for one backing call and its callback.
const BACKING_CALL_GAS: Gas = Gas::from_tgas(30);
const BACKING_CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Gas for the MPC signer call and for the callback that stores its answer.
const MPC_SIGN_GAS: Gas = Gas::from_tgas(250);
const SIGN_CALLBACK_GAS: Gas = Gas::from_tgas(15);
const MAX_SIGN_ATTEMPTS: u32 = 5;
const MAX_PAGE_SIZE: u64 = 100;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Workers,
    Battles,
    Positions,
    Rounds,
    Allocated,
    Decisions,
    Payouts,
    Grants,
    GrantSpent,
    Recipients,
    SignRequests,
}

#[ext_contract(ext_backing)]
pub trait BackingCalls {
    fn allocate_to_entitlements(&mut self, battle_id: u64, allocations: Vec<(AccountId, U128)>);
    fn reserve_payout(
        &mut self,
        battle_id: u64,
        beneficiary: AccountId,
        q: U128,
        kind: BackingPayoutKind,
    ) -> BackingPayout;
    fn reserve_disposal(
        &mut self,
        battle_id: u64,
        q: U128,
        kind: BackingDisposalKind,
    ) -> BackingDisposal;
}

/// JSON/borsh mirror of the backing contract's payout kind.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackingPayoutKind {
    Reward,
    Redemption,
}

/// JSON/borsh mirror of the backing contract's disposal kind.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackingDisposalKind {
    Burn,
    Return,
}

/// JSON mirror of the backing contract's payout record.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackingPayout {
    pub id: u64,
    pub battle_id: u64,
    pub beneficiary: AccountId,
    pub amount: U128,
    pub kind: BackingPayoutKind,
    pub nonce: u64,
}

/// JSON mirror of the backing contract's disposal record.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackingDisposal {
    pub id: u64,
    pub battle_id: u64,
    pub amount: U128,
    pub kind: BackingDisposalKind,
}

/// Deposit message accepted through `ft_transfer_call` on a backing token.
#[derive(Deserialize, Default)]
#[serde(crate = "near_sdk::serde")]
struct DepositMsg {
    battle_id: Option<u64>,
    community_index: Option<u16>,
    grant_id: Option<u64>,
}

/// The arena contract.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Arena {
    owner: AccountId,
    /// Protocol identity; receives the protocol fee share and can create
    /// protocol battles. Frozen protocol identity policy is OPEN.
    protocol: AccountId,
    /// Infrastructure workers: audit, observations, settlement, signing.
    workers: IterableSet<AccountId>,
    paused: bool,
    /// Committed observation policy; frozen into battles at lock.
    policy: PolicyRef,
    /// Evidence freshness window (OPEN policy, owner-configurable).
    audit_ttl_ns: u64,
    battles: LookupMap<u64, Battle>,
    battle_count: u64,
    /// Locked position units per (battle, community, account).
    positions: IterableMap<(u64, u16, AccountId), u128>,
    /// Observation evidence per (battle, round, community).
    rounds: LookupMap<(u64, u32, u16), RoundEvidence>,
    /// Losing communities already converted to entitlements.
    allocated: LookupSet<(u64, u16)>,
    /// Payout reservation registry used for constrained signing.
    payouts: LookupMap<u64, ArenaPayout>,
    decisions: LookupMap<u64, DaoDecision>,
    grants: IterableMap<u64, Grant>,
    grant_count: u64,
    /// Spent grant budget per (grant, asset).
    grant_spent: LookupMap<(u64, AccountId), u128>,
    /// NEAR account -> Robinhood address; authorized and frozen before signing.
    recipients: LookupMap<AccountId, String>,
    /// Foreign chain settings; `None` disables cross-chain signing.
    foreign: Option<ForeignConfig>,
    sign_requests: LookupMap<u64, SignRequest>,
    sign_request_count: u64,
}

#[near]
impl Arena {
    #[init]
    pub fn new(owner: AccountId, protocol: AccountId) -> Self {
        Self {
            owner,
            protocol,
            workers: IterableSet::new(StorageKey::Workers),
            paused: false,
            policy: PolicyRef {
                version: 0,
                policy_hash: String::new(),
            },
            audit_ttl_ns: 24 * 60 * 60 * NS_PER_SECOND,
            battles: LookupMap::new(StorageKey::Battles),
            battle_count: 0,
            positions: IterableMap::new(StorageKey::Positions),
            rounds: LookupMap::new(StorageKey::Rounds),
            allocated: LookupSet::new(StorageKey::Allocated),
            payouts: LookupMap::new(StorageKey::Payouts),
            decisions: LookupMap::new(StorageKey::Decisions),
            grants: IterableMap::new(StorageKey::Grants),
            grant_count: 0,
            grant_spent: LookupMap::new(StorageKey::GrantSpent),
            recipients: LookupMap::new(StorageKey::Recipients),
            foreign: None,
            sign_requests: LookupMap::new(StorageKey::SignRequests),
            sign_request_count: 0,
        }
    }

    // ─── Owner configuration ────────────────────────────────────────────

    pub fn set_protocol(&mut self, protocol: AccountId) {
        self.assert_owner();
        self.protocol = protocol;
    }

    pub fn add_worker(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.workers.insert(account_id);
    }

    pub fn remove_worker(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.workers.remove(&account_id);
    }

    /// Commits the versioned observation policy that will be frozen at lock.
    pub fn set_policy(&mut self, version: u64, policy_hash: String) {
        self.assert_owner();
        require!(!policy_hash.is_empty(), "Empty policy hash");
        self.policy = PolicyRef {
            version,
            policy_hash,
        };
    }

    /// Sets the evidence freshness window (OPEN policy).
    pub fn set_audit_ttl_secs(&mut self, secs: U64) {
        self.assert_owner();
        require!(secs.0 > 0, "TTL must be positive");
        self.audit_ttl_ns = secs.0 * NS_PER_SECOND;
    }

    pub fn set_foreign(&mut self, config: Option<ForeignConfigInput>) {
        self.assert_owner();
        self.foreign = config.map(|input| {
            ForeignConfig::from_input(input)
                .unwrap_or_else(|_| env::panic_str("Invalid foreign address"))
        });
    }

    pub fn pause(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    // ─── Battle creation and audit ──────────────────────────────────────

    /// Creates a battle with at least two distinct approved-eligible
    /// communities. No proposal bond. The creator must still deposit a real
    /// positive position before lock.
    pub fn create_battle(
        &mut self,
        mode: ScoringMode,
        communities: Vec<TokenIdentity>,
        protocol_created: bool,
    ) -> u64 {
        self.assert_active();
        require!(communities.len() >= 2, "At least two communities");
        for (i, community) in communities.iter().enumerate() {
            for other in communities.iter().skip(i + 1) {
                require!(
                    community.token_address != other.token_address
                        || community.chain_id != other.chain_id
                        || community.backing != other.backing,
                    "Duplicate community"
                );
            }
            require!(!community.token_address.is_empty(), "Missing token address");
            require!(
                community.backing != env::current_account_id(),
                "Backing must be a separate contract"
            );
        }
        let creator = env::predecessor_account_id();
        if protocol_created {
            require!(creator == self.protocol, "Only the protocol can create its battles");
        }

        let id = self.battle_count.checked_add(1).expect("battle count");
        self.battle_count = id;
        let battle = Battle {
            id,
            creator: creator.clone(),
            protocol_created,
            mode,
            status: BattleStatus::Proposed,
            communities: communities
                .into_iter()
                .enumerate()
                .map(|(index, token)| Community {
                    index: index as u16,
                    token,
                    audit: None,
                    vault: 0,
                    eliminated: false,
                })
                .collect(),
            policy_ref: None,
            created_at_ns: env::block_timestamp(),
            locked_at_ns: None,
            round: 0,
            round_start_ns: 0,
            round_end_ns: 0,
            candidates: Vec::new(),
            winner: None,
            settled_at_ns: None,
            escrow: None,
        };
        self.battles.insert(id, battle);
        events::emit(
            "battle_created",
            json!({
                "battle_id": id,
                "creator": creator,
                "mode": mode,
                "protocol_created": protocol_created,
            }),
        );
        id
    }

    /// Submits (or refreshes) a community's audit evidence. A worker-only
    /// role; evidence must bind to the community's chain/token identity.
    pub fn submit_audit(
        &mut self,
        battle_id: u64,
        community_index: u16,
        goplus: types::GoPlusEvidence,
        lp: types::LpEvidence,
    ) {
        self.assert_worker();
        self.assert_active();
        let mut battle = self.get_battle(battle_id);
        require!(
            !matches!(battle.status, BattleStatus::Settled | BattleStatus::Rejected),
            "Battle over"
        );
        let community = battle
            .communities
            .iter_mut()
            .find(|community| community.index == community_index)
            .unwrap_or_else(|| env::panic_str("Unknown community"));
        require!(
            goplus.chain_id == community.token.chain_id
                && goplus.token_address == community.token.token_address,
            "Audit evidence binds the wrong chain/token"
        );

        let decision = evaluate_audit(&goplus, &lp, env::block_timestamp(), self.audit_ttl_ns);
        community.audit = Some(types::AuditEvidence {
            decision,
            goplus,
            lp,
        });
        events::emit(
            "audit_submitted",
            json!({
                "battle_id": battle_id,
                "community_index": community_index,
                "decision": decision,
            }),
        );

        // Recompute the battle status: any Reject rejects the battle; all
        // Pass approves it; otherwise it stays Pending.
        if community.audit.as_ref().unwrap().decision == AuditDecision::Reject {
            battle.status = BattleStatus::Rejected;
            self.battles.insert(battle_id, battle);
            return;
        }
        let all_passed = battle.communities.iter().all(|community| {
            matches!(
                community.audit.as_ref().map(|evidence| evidence.decision),
                Some(AuditDecision::Pass)
            )
        });
        if all_passed {
            battle.status = BattleStatus::Approved;
        } else {
            battle.status = BattleStatus::Proposed;
        }
        self.battles.insert(battle_id, battle);
    }

    // ─── Deposits ───────────────────────────────────────────────────────

    /// NEP-141 receiver for backing representations. Before lock this locks
    /// the deposit into the battle vault; after lock (or for unknown
    /// battles/communities) the full amount is returned so the funds stay
    /// recoverable outside the live vault.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        if amount.0 == 0 {
            return PromiseOrValue::Value(U128(0));
        }
        let parsed: DepositMsg = near_sdk::serde_json::from_str(&msg).unwrap_or_default();
        let Some(battle_id) = parsed.battle_id else {
            return PromiseOrValue::Value(amount);
        };
        let Some(community_index) = parsed.community_index else {
            return PromiseOrValue::Value(amount);
        };

        let Some(battle) = self.battles.get(&battle_id).cloned() else {
            return PromiseOrValue::Value(amount);
        };
        // The token must be this community's representation contract.
        let community = battle
            .communities
            .iter()
            .find(|community| community.index == community_index)
            .unwrap_or_else(|| env::panic_str("Unknown community"));
        require!(
            community.token.backing == token,
            "Wrong backing contract for community"
        );

        // After lock every deposit is refunded: it cannot change the snapshot.
        if !matches!(battle.status, BattleStatus::Approved) {
            return PromiseOrValue::Value(amount);
        }

        // Grant-bound deposits spend the agent grant budget on-chain.
        if let Some(grant_id) = parsed.grant_id {
            let mut grant = self
                .grants
                .get(&grant_id)
                .cloned()
                .unwrap_or_else(|| env::panic_str("Unknown grant"));
            require!(grant.agent == sender_id, "Grant is not bound to the sender");
            let action = grants::ActionRequest {
                method: "deposit",
                asset: token.clone(),
                chain_id: community.token.chain_id,
                amount: Some(amount.0),
                destination: None,
            };
            grants::authorize(&grant, &action, env::block_timestamp())
                .unwrap_or_else(|_| env::panic_str("Grant does not authorize this deposit"));
            grants::spend(&mut grant, &token, amount.0);
            self.grants.insert(grant_id, grant);
        }

        // Credit the vault and the position.
        let mut battle = battle;
        let community = battle
            .communities
            .iter_mut()
            .find(|community| community.index == community_index)
            .expect("community");
        community.vault = community.vault.checked_add(amount.0).expect("vault overflow");
        let position_key = (battle_id, community_index, sender_id.clone());
        let held = self.positions.get(&position_key).copied().unwrap_or(0);
        self.positions
            .insert(position_key, held.checked_add(amount.0).expect("position overflow"));
        self.battles.insert(battle_id, battle);

        events::emit(
            "deposit_locked",
            json!({
                "battle_id": battle_id,
                "community_index": community_index,
                "account": sender_id,
                "amount": amount,
                "token": token,
            }),
        );
        PromiseOrValue::Value(U128(0))
    }

    // ─── Lock and rounds ────────────────────────────────────────────────

    /// Freezes the snapshot before round 1: communities, deposits, mode, fee
    /// identity and policies. Requires every community audited Pass with
    /// fresh evidence, every vault positive and a real creator position.
    /// Repeated lock requests leave the original snapshot unchanged.
    pub fn lock(&mut self, battle_id: u64) {
        self.assert_worker();
        self.assert_active();
        let mut battle = self.get_battle(battle_id);
        if matches!(battle.status, BattleStatus::Live | BattleStatus::Settled) {
            return; // idempotent
        }
        require!(battle.status == BattleStatus::Approved, "Not approved");
        require!(
            !self.policy.policy_hash.is_empty(),
            "Observation policy not committed"
        );
        let now = env::block_timestamp();
        for community in &battle.communities {
            let evidence = community
                .audit
                .as_ref()
                .unwrap_or_else(|| env::panic_str("Missing audit evidence"));
            require!(
                evidence.decision == AuditDecision::Pass,
                "Community audit did not pass"
            );
            // Refresh freshness at lock time under the versioned TTL.
            let fresh = evaluate_audit(&evidence.goplus, &evidence.lp, now, self.audit_ttl_ns);
            require!(fresh == AuditDecision::Pass, "Audit evidence expired");
            require!(community.vault > 0, "Community has no vault");
        }

        // Mandatory real creator participation: a positive locked position.
        let creator = battle.creator.clone();
        let mut creator_stake = 0u128;
        for community in &battle.communities {
            let key = (battle_id, community.index, creator.clone());
            creator_stake = creator_stake.saturating_add(
                self.positions.get(&key).copied().unwrap_or(0),
            );
        }
        require!(creator_stake > 0, "Creator has no real participating position");

        battle.policy_ref = Some(self.policy.clone());
        battle.status = BattleStatus::Live;
        battle.locked_at_ns = Some(now);
        battle.round = 1;
        battle.round_start_ns = now;
        battle.round_end_ns = now.checked_add(ROUND_SECS * NS_PER_SECOND).expect("time");
        battle.candidates = battle.communities.iter().map(|c| c.index).collect();
        let round_end_ns = battle.round_end_ns;
        self.battles.insert(battle_id, battle);
        events::emit(
            "battle_locked",
            json!({ "battle_id": battle_id, "round": 1, "round_end_ns": round_end_ns }),
        );
    }

    /// Submits one piece of round evidence for a candidate community. Point
    /// observations only; invalid data is rejected, missing data holds the
    /// round pending.
    pub fn submit_observation(
        &mut self,
        battle_id: u64,
        community_index: u16,
        kind: ObservationKind,
    ) {
        self.assert_worker();
        self.assert_active();
        let battle = self.get_battle(battle_id);
        require!(battle.status == BattleStatus::Live, "Not live");
        require!(
            battle.candidates.contains(&community_index),
            "Community is not a candidate"
        );
        let round = battle.round;
        let key = (battle_id, round, community_index);
        let mut evidence = self.rounds.get(&key).cloned().unwrap_or_default();

        match kind {
            ObservationKind::StartPrice { price } => {
                require!(price.0 > 0, "Nonpositive price");
                evidence.start_price = Some(price);
            }
            ObservationKind::EndPrice { price } => {
                require!(price.0 > 0, "Nonpositive price");
                evidence.end_price = Some(price);
            }
            ObservationKind::StartSupply { supply } => {
                require!(supply.0 > 0, "Invalid supply");
                evidence.start_supply = Some(supply);
            }
            ObservationKind::EndSupply { supply } => {
                require!(supply.0 > 0, "Invalid supply");
                evidence.end_supply = Some(supply);
            }
            ObservationKind::Volume { quote_units } => {
                require!(quote_units.0 > 0, "Negative volume");
                evidence.volume = Some(quote_units);
            }
            ObservationKind::Path { prices } => {
                require!(prices.len() >= 2, "Path too short");
                for price in &prices {
                    require!(price.0 > 0, "Nonpositive price in path");
                }
                evidence.path = Some(prices);
            }
        }
        self.rounds.insert(key, evidence);
        events::emit(
            "observation_submitted",
            json!({ "battle_id": battle_id, "round": round, "community_index": community_index }),
        );
    }

    /// Resolves the current round for a unique best score, or advances only
    /// the tied leaders to a fresh 30-second round with reset inputs. Late
    /// scheduler calls use the recorded interval evidence and never shift the
    /// close. Missing evidence holds the round pending.
    pub fn resolve_round(&mut self, battle_id: u64) {
        self.assert_worker();
        self.assert_active();
        let mut battle = self.get_battle(battle_id);
        require!(battle.status == BattleStatus::Live, "Not live");
        let now = env::block_timestamp();
        require!(now >= battle.round_end_ns, "Round is still running");

        // Complete mode-specific evidence for every candidate.
        let round = battle.round;
        let requirements = battle.mode.requires();
        let mut scores: Vec<(u16, Score)> = Vec::with_capacity(battle.candidates.len());
        for index in &battle.candidates {
            let key = (battle_id, round, *index);
            let evidence = self
                .rounds
                .get(&key)
                .cloned()
                .unwrap_or_else(|| env::panic_str("Missing round evidence"));
            let score = score_for(battle.mode, &evidence, requirements);
            scores.push((*index, score));
        }

        // Select the best by the mode's direction; ties advance together.
        let highest = best_is_highest(battle.mode);
        let mut best_score = scores[0].1;
        let mut leaders = vec![scores[0].0];
        for (index, score) in scores.into_iter().skip(1) {
            let better = if highest {
                score.value.cmp(&best_score.value) == std::cmp::Ordering::Greater
            } else {
                score.value.cmp(&best_score.value) == std::cmp::Ordering::Less
            };
            let equal = score.value == best_score.value;
            if better {
                best_score = score;
                leaders = vec![index];
            } else if equal {
                leaders.push(index);
            }
        }

        if leaders.len() == 1 {
            let winner = leaders[0];
            battle.winner = Some(winner);
            battle.status = BattleStatus::Settled;
            battle.settled_at_ns = Some(now);
            let winner_community = battle
                .communities
                .iter()
                .find(|community| community.index == winner)
                .expect("winner community");
            battle.escrow = Some(DaoEscrow {
                battle_id,
                principal: U128(winner_community.vault),
                status: EscrowStatus::Escrowed,
            });
            self.battles.insert(battle_id, battle);
            events::emit(
                "battle_settled",
                json!({ "battle_id": battle_id, "winner": winner, "rounds": round }),
            );
        } else {
            battle.round = battle.round.checked_add(1).expect("round");
            battle.round_start_ns = now;
            battle.round_end_ns = now.checked_add(ROUND_SECS * NS_PER_SECOND).expect("time");
            battle.candidates = leaders;
            for community in &mut battle.communities {
                if !battle.candidates.contains(&community.index) {
                    community.eliminated = true;
                }
            }
            let new_round = battle.round;
            let candidates = battle.candidates.clone();
            self.battles.insert(battle_id, battle);
            events::emit(
                "overtime_round",
                json!({
                    "battle_id": battle_id,
                    "round": new_round,
                    "leaders": candidates,
                }),
            );
        }
    }

    // ─── Settlement allocation ──────────────────────────────────────────

    /// Converts one losing community's locked vault into entitlements:
    /// 99.9% winner pool (by locked winner units), 0.05% creator and 0.05%
    /// protocol (or all 0.1% protocol for protocol-created battles). One
    /// backing call per losing token; replays are refused by the backing
    /// contract.
    pub fn allocate_loser(&mut self, battle_id: u64, community_index: u16) -> Promise {
        self.assert_worker();
        self.assert_active();
        let battle = self.get_battle(battle_id);
        require!(battle.status == BattleStatus::Settled, "Not settled");
        let winner = battle.winner.expect("winner set");
        require!(community_index != winner, "Winner vault is not allocated");
        require!(
            !self.allocated.contains(&(battle_id, community_index)),
            "Already allocated"
        );

        let community = battle
            .communities
            .iter()
            .find(|community| community.index == community_index)
            .expect("community");
        let losing_vault = community.vault;

        // Winner participants by locked winner units.
        let mut weights: Vec<(AccountId, u128)> = Vec::new();
        let mut total_weight: u128 = 0;
        for (key, units) in self.positions.iter() {
            if key.0 == battle_id && key.1 == winner {
                weights.push((key.2.clone(), *units));
                total_weight = total_weight.checked_add(*units).expect("weight");
            }
        }
        require!(total_weight > 0, "Empty winner community");

        let split = split_loser_vault(losing_vault, battle.protocol_created);
        let mut allocations = distribute_winner_pool(split.winner_pool, &weights, total_weight);
        if split.creator_fee > 0 {
            allocations.push((battle.creator.clone(), split.creator_fee));
        }
        if split.protocol_fee > 0 {
            allocations.push((self.protocol.clone(), split.protocol_fee));
        }

        self.allocated.insert((battle_id, community_index));
        let allocations: Vec<(AccountId, U128)> = allocations
            .into_iter()
            .map(|(account, q)| (account, U128(q)))
            .collect();
        let backing = community.token.backing.clone();
        events::emit(
            "allocation_requested",
            json!({
                "battle_id": battle_id,
                "community_index": community_index,
                "token": backing,
                "split": {
                    "winner_pool": split.winner_pool,
                    "creator_fee": split.creator_fee,
                    "protocol_fee": split.protocol_fee,
                },
            }),
        );
        ext_backing::ext(backing)
            .with_static_gas(BACKING_CALL_GAS)
            .allocate_to_entitlements(battle_id, allocations)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(BACKING_CALLBACK_GAS)
                    .on_allocated(battle_id, community_index),
            )
    }

    #[private]
    pub fn on_allocated(
        &mut self,
        battle_id: u64,
        community_index: u16,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            // The backing contract refused (or the call failed): unmark so a
            // retry is possible; entitlements are never double-allocated.
            self.allocated.remove(&(battle_id, community_index));
            events::emit(
                "allocation_failed",
                json!({ "battle_id": battle_id, "community_index": community_index }),
            );
            return;
        }
        events::emit(
            "allocation_confirmed",
            json!({ "battle_id": battle_id, "community_index": community_index }),
        );
    }

    // ─── Payouts ────────────────────────────────────────────────────────

    /// Registers (or replaces) the Robinhood address that a NEAR account's
    /// payouts may be sent to. Authorized before a payout is signed.
    pub fn register_recipient(&mut self, address: String) {
        let parsed = mpc::parse_address(&address)
            .unwrap_or_else(|_| env::panic_str("Invalid Robinhood address"));
        require!(!parsed.iter().all(|b| *b == 0), "Zero address not allowed");
        self.recipients.insert(env::predecessor_account_id(), address);
    }

    /// Reserves `q` units of a beneficiary's losing-token entitlement for a
    /// payout through the backing contract: `E -> P`.
    pub fn request_payout(
        &mut self,
        battle_id: u64,
        community_index: u16,
        beneficiary: AccountId,
        q: U128,
    ) -> Promise {
        self.assert_active();
        let battle = self.get_battle(battle_id);
        require!(battle.status == BattleStatus::Settled, "Not settled");
        require!(battle.winner != Some(community_index), "Winner vault pays no reward");
        let community = battle
            .communities
            .iter()
            .find(|community| community.index == community_index)
            .expect("community");
        let backing = community.token.backing.clone();
        let caller = env::predecessor_account_id();
        require!(caller == beneficiary, "Only the beneficiary may request its payout");
        require!(
            self.recipients.contains_key(&beneficiary),
            "Register a Robinhood recipient first"
        );
        require!(q.0 > 0, "Zero payout");
        ext_backing::ext(backing)
            .with_static_gas(BACKING_CALL_GAS)
            .reserve_payout(battle_id, beneficiary, q, BackingPayoutKind::Reward)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(BACKING_CALLBACK_GAS)
                    .on_payout_reserved(battle_id, community_index),
            )
    }

    /// Records the backing payout reservation in the arena registry used for
    /// constrained signing. Replays are harmless: the record is overwritten
    /// with the same identity.
    #[private]
    pub fn on_payout_reserved(
        &mut self,
        battle_id: u64,
        community_index: u16,
        #[callback_result] result: Result<BackingPayout, PromiseError>,
    ) {
        let Ok(payout) = result else {
            events::emit(
                "payout_reserve_failed",
                json!({ "battle_id": battle_id, "community_index": community_index }),
            );
            return;
        };
        self.payouts.insert(
            payout.id,
            ArenaPayout {
                id: payout.id,
                battle_id,
                community_index,
                beneficiary: payout.beneficiary.clone(),
                amount: payout.amount.0,
                nonce: payout.nonce,
            },
        );
        events::emit(
            "payout_registered",
            json!({ "payout_id": payout.id, "battle_id": battle_id, "beneficiary": payout.beneficiary }),
        );
    }

    // ─── DAO escrow ─────────────────────────────────────────────────────

    /// Records an explicit DAO decision for a battle's escrowed principal.
    /// Governance (membership/weights/quorum/deadline) stays OPEN; nothing
    /// is invented here. The owner records decisions until a DAO is designed.
    pub fn record_decision(
        &mut self,
        battle_id: u64,
        kind: DisposalKind,
        decision_ref: String,
    ) {
        self.assert_owner();
        let battle = self.get_battle(battle_id);
        require!(battle.status == BattleStatus::Settled, "Not settled");
        require!(battle.escrow.is_some(), "No escrow");
        require!(!self.decisions.contains_key(&battle_id), "Decision exists");
        self.decisions.insert(
            battle_id,
            DaoDecision {
                battle_id,
                kind,
                recorded_at_ns: U64(env::block_timestamp()),
                decision_ref,
                consumed: false,
            },
        );
        events::emit(
            "dao_decision_recorded",
            json!({ "battle_id": battle_id, "kind": kind }),
        );
    }

    /// Executes a recorded decision at most once by reserving the escrowed
    /// principal for verified underlying disposal (`M -> D`).
    pub fn dispose_principal(&mut self, battle_id: u64) -> Promise {
        self.assert_owner();
        self.assert_active();
        let decision = self
            .decisions
            .get(&battle_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("No recorded decision"));
        require!(!decision.consumed, "Decision already consumed");
        let mut battle = self.get_battle(battle_id);
        let escrow = battle
            .escrow
            .as_mut()
            .unwrap_or_else(|| env::panic_str("No escrow"));
        require!(escrow.status == EscrowStatus::Escrowed, "Not escrowed");

        let winner = battle.winner.expect("winner");
        let community = battle
            .communities
            .iter()
            .find(|community| community.index == winner)
            .expect("winner community");
        let backing = community.token.backing.clone();
        let principal = escrow.principal.0;
        escrow.status = EscrowStatus::Disposing;
        self.battles.insert(battle_id, battle);

        ext_backing::ext(backing)
            .with_static_gas(BACKING_CALL_GAS)
            .reserve_disposal(battle_id, U128(principal), BackingDisposalKind::Burn)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(BACKING_CALLBACK_GAS)
                    .on_disposal_reserved(battle_id, decision.kind),
            )
    }

    #[private]
    pub fn on_disposal_reserved(
        &mut self,
        battle_id: u64,
        kind: DisposalKind,
        #[callback_result] result: Result<BackingDisposal, PromiseError>,
    ) {
        if result.is_err() {
            let mut battle = self.get_battle(battle_id);
            if let Some(escrow) = battle.escrow.as_mut() {
                escrow.status = EscrowStatus::Escrowed;
            }
            self.battles.insert(battle_id, battle);
            events::emit(
                "disposal_reserve_failed",
                json!({ "battle_id": battle_id }),
            );
            return;
        }
        let _ = kind;
        events::emit(
            "disposal_reserved",
            json!({ "battle_id": battle_id, "disposal_id": result.unwrap().id }),
        );
    }

    /// Marks the escrow disposed after the verifier confirmed the underlying
    /// burn/sink or return on the backing contract.
    pub fn confirm_disposal(&mut self, battle_id: u64) {
        self.assert_worker();
        let mut battle = self.get_battle(battle_id);
        let escrow = battle
            .escrow
            .as_mut()
            .unwrap_or_else(|| env::panic_str("No escrow"));
        require!(escrow.status == EscrowStatus::Disposing, "Not disposing");
        escrow.status = EscrowStatus::Disposed;
        self.battles.insert(battle_id, battle);
        if let Some(decision) = self.decisions.get_mut(&battle_id) {
            decision.consumed = true;
        }
        events::emit("disposal_confirmed", json!({ "battle_id": battle_id }));
    }

    // ─── Player-agent grants ────────────────────────────────────────────

    /// Creates a bounded grant for a player agent. The grantor is the caller.
    pub fn create_grant(
        &mut self,
        agent: AccountId,
        budget: Vec<(AccountId, U128)>,
        methods: Vec<String>,
        chains: Vec<u64>,
        assets: Vec<AccountId>,
        expires_at_ns: U64,
    ) -> u64 {
        self.assert_active();
        require!(!budget.is_empty(), "Empty grant budget");
        require!(!methods.is_empty(), "Empty method list");
        let id = self.grant_count.checked_add(1).expect("grant count");
        self.grant_count = id;
        self.grants.insert(
            id,
            Grant {
                id,
                grantor: env::predecessor_account_id(),
                agent,
                budget,
                methods,
                chains,
                assets,
                expires_at_ns,
                revoked: false,
            },
        );
        events::emit("grant_created", json!({ "grant_id": id }));
        id
    }

    pub fn revoke_grant(&mut self, grant_id: u64) {
        let mut grant = self
            .grants
            .get(&grant_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Unknown grant"));
        require!(
            grant.grantor == env::predecessor_account_id() || env::predecessor_account_id() == self.owner,
            "Grantor only"
        );
        grant.revoked = true;
        self.grants.insert(grant_id, grant);
        events::emit("grant_revoked", json!({ "grant_id": grant_id }));
    }

    // ─── Constrained signing ────────────────────────────────────────────

    /// Requests an MPC signature for a payout transaction. The transaction
    /// must be exactly the constrained transfer reconstructed from the
    /// backing payout reservation: chain, token, recipient, amount and nonce
    /// all match. Infrastructure cannot request arbitrary spending.
    pub fn request_signature(&mut self, payout_id: u64, tx: mpc::EvmTx) -> Promise {
        self.assert_worker();
        self.assert_active();
        let config = self
            .foreign
            .as_ref()
            .unwrap_or_else(|| env::panic_str("Foreign signing disabled"));

        // The payout record and its community token: reconstruct the allowed
        // fields from the reservation identity.
        let (battle_id, beneficiary, amount, nonce, token_address) = self
            .payout_context(payout_id)
            .unwrap_or_else(|| env::panic_str("Unknown payout reservation"));

        let token = mpc::parse_address(&token_address)
            .unwrap_or_else(|_| env::panic_str("Invalid token address"));
        let to = self
            .recipients
            .get(&beneficiary)
            .map(|address| mpc::parse_address(address).unwrap_or_else(|_| env::panic_str("Invalid recipient address")))
            .unwrap_or_else(|| env::panic_str("Beneficiary has no recipient mapping"));
        let spec = mpc::PayoutSpec {
            token,
            to,
            amount,
            nonce,
            chain_id: config.chain_id,
        };
        mpc::verify_payout_tx(config, &spec, &tx)
            .unwrap_or_else(|_| env::panic_str("Transaction does not match the reservation"));

        let request_id = self.sign_request_count.checked_add(1).expect("request id");
        self.sign_request_count = request_id;
        let payload_hash = tx.signing_hash();
        let path = format!("valtrum-payout-{payout_id}");
        self.sign_requests.insert(
            request_id,
            SignRequest {
                payout_id,
                path,
                tx,
                status: SignStatus::Pending,
                signed_tx: None,
                attempts: 0,
            },
        );
        let _ = battle_id;
        events::emit(
            "signature_requested",
            json!({
                "request_id": request_id,
                "payout_id": payout_id,
                "payload_hash": mpc::hex_encode(&payload_hash),
            }),
        );
        self.send_to_signer(request_id)
    }

    /// Asks the signer again for a request whose attempt failed.
    pub fn retry_signature(&mut self, request_id: u64) -> Promise {
        self.assert_worker();
        let request = self
            .sign_requests
            .get_mut(&request_id)
            .unwrap_or_else(|| env::panic_str("Request not found"));
        require!(
            request.status == SignStatus::Failed,
            "Only a failed request can be retried"
        );
        require!(
            request.attempts < MAX_SIGN_ATTEMPTS,
            "Too many failed attempts"
        );
        request.status = SignStatus::Pending;
        self.send_to_signer(request_id)
    }

    /// Stores the MPC signature as a signed transaction, or marks the attempt
    /// as failed so it can be retried. Never panics.
    #[private]
    pub fn on_signature(
        &mut self,
        request_id: u64,
        #[callback_result] result: Result<near_sdk::serde_json::Value, PromiseError>,
    ) {
        let Some(request) = self.sign_requests.get_mut(&request_id) else {
            return;
        };
        if request.status != SignStatus::Pending {
            return;
        }
        let outcome = match result {
            Ok(response) => mpc::parse_signature(&response)
                .map_err(|_| "unusable signer response")
                .map(|signature| request.tx.signed(&signature)),
            Err(_) => Err("signer call failed"),
        };
        match outcome {
            Ok(signed) => {
                let tx_hash = mpc::hex_encode(&mpc::tx_hash(&signed));
                request.signed_tx = Some(signed);
                request.status = SignStatus::Signed;
                events::emit(
                    "signature_ready",
                    json!({
                        "request_id": request_id,
                        "payout_id": request.payout_id,
                        "signed_tx": tx_hash,
                    }),
                );
            }
            Err(reason) => {
                request.attempts += 1;
                request.status = SignStatus::Failed;
                events::emit(
                    "signature_failed",
                    json!({
                        "request_id": request_id,
                        "reason": reason,
                        "attempts": request.attempts,
                    }),
                );
            }
        }
    }

    // ─── Views ──────────────────────────────────────────────────────────

    pub fn config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            protocol: self.protocol.clone(),
            paused: self.paused,
            policy: self.policy.clone(),
            audit_ttl_secs: self.audit_ttl_ns / NS_PER_SECOND,
            foreign: self.foreign.clone(),
            battle_count: self.battle_count,
        }
    }

    pub fn battle(&self, battle_id: u64) -> Option<BattleView> {
        self.battles.get(&battle_id).map(|battle| BattleView::from(&battle))
    }

    pub fn battles(&self, from: Option<u64>, limit: Option<u64>) -> Vec<BattleView> {
        let start = from.unwrap_or(1).max(1);
        let limit = limit.unwrap_or(MAX_PAGE_SIZE).min(MAX_PAGE_SIZE);
        (start..start + limit)
            .filter_map(|id| self.battles.get(&id).map(|battle| BattleView::from(&battle)))
            .collect()
    }

    pub fn position(&self, battle_id: u64, community_index: u16, account_id: AccountId) -> U128 {
        U128(
            self.positions
                .get(&(battle_id, community_index, account_id))
                .copied()
                .unwrap_or(0),
        )
    }

    pub fn positions_of(&self, battle_id: u64, account_id: AccountId) -> Vec<PositionView> {
        let mut out = Vec::new();
        for (key, units) in self.positions.iter() {
            if key.0 == battle_id && key.2 == account_id {
                out.push(PositionView {
                    community_index: key.1,
                    units: U128(*units),
                });
            }
        }
        out
    }

    pub fn round_evidence(&self, battle_id: u64, round: u32) -> Vec<RoundView> {
        let mut out = Vec::new();
        if let Some(battle) = self.battles.get(&battle_id) {
            for community in &battle.communities {
                let key = (battle_id, round, community.index);
                if let Some(evidence) = self.rounds.get(&key) {
                    out.push(RoundView {
                        community_index: community.index,
                        evidence: evidence.clone(),
                    });
                }
            }
        }
        out
    }

    pub fn escrow(&self, battle_id: u64) -> Option<DaoEscrow> {
        self.battles.get(&battle_id).and_then(|battle| battle.escrow.clone())
    }

    pub fn decision(&self, battle_id: u64) -> Option<DaoDecision> {
        self.decisions.get(&battle_id).cloned()
    }

    pub fn recipient(&self, account_id: AccountId) -> Option<String> {
        self.recipients.get(&account_id).cloned()
    }

    pub fn grant(&self, grant_id: u64) -> Option<Grant> {
        self.grants.get(&grant_id).cloned()
    }

    pub fn grants_of(&self, grantor: AccountId) -> Vec<Grant> {
        self.grants
            .values()
            .filter(|grant| grant.grantor == grantor)
            .cloned()
            .collect()
    }

    pub fn sign_request(&self, request_id: u64) -> Option<SignRequest> {
        self.sign_requests.get(&request_id).cloned()
    }

    // ─── Internals ──────────────────────────────────────────────────────

    fn get_battle(&self, battle_id: u64) -> Battle {
        self.battles
            .get(&battle_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Unknown battle"))
    }

    /// Looks up a payout reservation's context for constrained signing.
    /// The arena keeps the authoritative mapping because it initiated the
    /// reservation; the backing contract's record carries the same identity.
    fn payout_context(&self, payout_id: u64) -> Option<(u64, AccountId, u128, u64, String)> {
        // Payouts are reserved by the arena on the backing contracts; the
        // reservation identity is (payout_id -> battle/beneficiary/amount/
        // nonce). The arena stores the mapping when it requests a payout.
        let payout = self.payouts.get(&payout_id)?;
        let battle = self.get_battle(payout.battle_id);
        let community = battle
            .communities
            .iter()
            .find(|community| community.index == payout.community_index)?;
        Some((
            payout.battle_id,
            payout.beneficiary.clone(),
            payout.amount,
            payout.nonce,
            community.token.token_address.clone(),
        ))
    }

    fn send_to_signer(&mut self, request_id: u64) -> Promise {
        let config = self
            .foreign
            .as_ref()
            .cloned()
            .unwrap_or_else(|| env::panic_str("Foreign signing disabled"));
        let request = self
            .sign_requests
            .get(&request_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Request not found"));
        let (path, tx) = (request.path, request.tx);
        let args = json!({
            "request": {
                "path": path,
                "payload_v2": { "Ecdsa": mpc::hex_encode(&tx.signing_hash()) },
                "domain_id": 0,
            }
        })
        .to_string()
        .into_bytes();
        Promise::new(config.mpc_contract.clone())
            .function_call(
                "sign".to_string(),
                args,
                NearToken::from_yoctonear(1),
                MPC_SIGN_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(SIGN_CALLBACK_GAS)
                    .on_signature(request_id),
            )
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Owner only");
    }

    fn assert_worker(&self) {
        require!(
            self.workers.contains(&env::predecessor_account_id())
                || env::predecessor_account_id() == self.owner,
            "Worker only"
        );
    }

    fn assert_active(&self) {
        require!(!self.paused, "Contract paused");
    }
}

/// Computes the score for a community's round evidence under the mode.
fn score_for(
    mode: ScoringMode,
    evidence: &RoundEvidence,
    requirements: types::ModeRequirements,
) -> Score {
    let start_price = required(evidence.start_price, requirements.start_price, "start price");
    let end_price = required(evidence.end_price, requirements.end_price, "end price");
    let start_supply = required(evidence.start_supply, requirements.supply, "start supply");
    let end_supply = required(evidence.end_supply, requirements.supply, "end supply");
    let volume = required(evidence.volume, requirements.volume, "volume");
    let path = evidence.path.clone();

    match mode {
        ScoringMode::PriceGain => price_gain(start_price, end_price),
        ScoringMode::MarketCapGrowth => {
            market_cap_growth(start_price, start_supply, end_price, end_supply)
        }
        ScoringMode::VolumeRatio => volume_ratio(volume, start_price, start_supply),
        ScoringMode::LowestDrawdown => {
            let path = path.unwrap_or_else(|| env::panic_str("Missing drawdown path"));
            let path: Vec<u128> = path.into_iter().map(|price| price.0).collect();
            max_drawdown(&path)
        }
    }
}

fn required(value: Option<U128>, needed: bool, what: &str) -> u128 {
    if needed {
        value.unwrap_or_else(|| env::panic_str(&format!("Missing evidence: {what}"))).0
    } else {
        value.unwrap_or(U128(0)).0
    }
}

/// Observation submission kinds.
#[near(serializers = [json])]
#[serde(tag = "kind", rename_all = "snake_case")]
#[derive(Clone, Debug)]
pub enum ObservationKind {
    StartPrice { price: U128 },
    EndPrice { price: U128 },
    StartSupply { supply: U128 },
    EndSupply { supply: U128 },
    Volume { quote_units: U128 },
    Path { prices: Vec<U128> },
}

/// Mirrors the backing payout record inside the arena for constrained
/// signing lookups. Populated when a payout is reserved.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArenaPayout {
    pub id: u64,
    pub battle_id: u64,
    pub community_index: u16,
    pub beneficiary: AccountId,
    pub amount: u128,
    pub nonce: u64,
}

#[cfg(test)]
mod tests;