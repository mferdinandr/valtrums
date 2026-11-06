use crate::mpc::ForeignConfig;
use crate::types::{Battle, BattleStatus, PolicyRef, RoundEvidence, ScoringMode, DaoEscrow};
use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigView {
    pub owner: AccountId,
    pub protocol: AccountId,
    pub paused: bool,
    pub policy: PolicyRef,
    pub audit_ttl_secs: u64,
    pub foreign: Option<ForeignConfig>,
    pub battle_count: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BattleView {
    pub id: u64,
    pub creator: AccountId,
    pub protocol_created: bool,
    pub mode: ScoringMode,
    pub status: BattleStatus,
    pub communities: Vec<CommunityView>,
    pub policy_ref: Option<PolicyRef>,
    pub created_at_ns: U64,
    pub locked_at_ns: Option<U64>,
    pub round: u32,
    pub round_start_ns: U64,
    pub round_end_ns: U64,
    pub candidates: Vec<u16>,
    pub winner: Option<u16>,
    pub settled_at_ns: Option<U64>,
    pub escrow: Option<DaoEscrow>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommunityView {
    pub index: u16,
    pub token: crate::types::TokenIdentity,
    pub audit_decision: Option<crate::types::AuditDecision>,
    pub vault: U128,
    pub eliminated: bool,
}

impl BattleView {
    pub fn from(battle: &Battle) -> Self {
        BattleView {
            id: battle.id,
            creator: battle.creator.clone(),
            protocol_created: battle.protocol_created,
            mode: battle.mode,
            status: battle.status,
            communities: battle
                .communities
                .iter()
                .map(|community| CommunityView {
                    index: community.index,
                    token: community.token.clone(),
                    audit_decision: community
                        .audit
                        .as_ref()
                        .map(|evidence| evidence.decision),
                    vault: U128(community.vault),
                    eliminated: community.eliminated,
                })
                .collect(),
            policy_ref: battle.policy_ref.clone(),
            created_at_ns: U64(battle.created_at_ns),
            locked_at_ns: battle.locked_at_ns.map(U64),
            round: battle.round,
            round_start_ns: U64(battle.round_start_ns),
            round_end_ns: U64(battle.round_end_ns),
            candidates: battle.candidates.clone(),
            winner: battle.winner,
            settled_at_ns: battle.settled_at_ns.map(U64),
            escrow: battle.escrow.clone(),
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PositionView {
    pub community_index: u16,
    pub units: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundView {
    pub community_index: u16,
    pub evidence: RoundEvidence,
}