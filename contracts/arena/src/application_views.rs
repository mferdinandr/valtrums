//! Additive application ABI. Views expose stored evidence, never foreign backing proof.
use crate::{lifecycle, Arena, ArenaExt};
use near_sdk::json_types::U64;
use near_sdk::{env, near, AccountId};

#[near(serializers = [json])]
pub struct BackingReadinessV1 {
    pub community: u32,
    pub representation: AccountId,
    pub trusted: bool,
    pub asset_matches: bool,
    pub evidence_hash: Option<String>,
    pub expires_at_ms: Option<U64>,
    pub fresh: bool,
}

#[near(serializers = [json])]
pub struct ApplicationReadinessV1 {
    pub schema_version: String,
    pub block_height: U64,
    pub observed_at_ms: U64,
    pub activated: bool,
    pub paused: bool,
    pub legacy_battle_count: U64,
    pub activation_blocked_by_legacy: bool,
    pub protocol: Option<AccountId>,
    pub oracle: Option<AccountId>,
    pub observation_policy: Option<lifecycle::ObservationPolicyInput>,
    pub audit_policy_hash: Option<String>,
    pub battle_found: Option<bool>,
    pub backings: Option<Vec<BackingReadinessV1>>,
}

#[near]
impl Arena {
    pub fn get_lifecycle_battle_count_v1(&self) -> U64 {
        U64(self.lifecycle_battle_count)
    }

    pub fn get_lifecycle_battle_v1(&self, battle_id: U64) -> Option<lifecycle::LifecycleView> {
        self.get_lifecycle_battle(battle_id.0)
    }

    pub fn get_lifecycle_position_v1(
        &self,
        battle_id: U64,
        community: u32,
        account: AccountId,
    ) -> lifecycle::LifecyclePositionView {
        self.get_lifecycle_position(battle_id.0, community, account)
    }

    pub fn get_lifecycle_readiness_v1(&self, battle_id: Option<U64>) -> ApplicationReadinessV1 {
        let battle = battle_id.and_then(|id| self.lifecycle_battles.get(&id.0));
        let now = env::block_timestamp_ms();
        ApplicationReadinessV1 {
            schema_version: "lifecycle-application-v1".into(),
            block_height: U64(env::block_height()),
            observed_at_ms: U64(now),
            activated: self.lifecycle_exclusive,
            paused: self.paused,
            legacy_battle_count: U64(self.battle_count),
            activation_blocked_by_legacy: self.battle_count != 0,
            protocol: self.lifecycle_protocol.clone(),
            oracle: self.lifecycle_oracle.clone(),
            observation_policy: self.lifecycle_observation_policy.as_ref().map(|p| {
                lifecycle::ObservationPolicyInput {
                    version: U64(p.version),
                    policy_hash: p.policy_hash.clone(),
                }
            }),
            audit_policy_hash: self.lifecycle_audit_policy_hash.clone(),
            battle_found: battle_id.map(|_| battle.is_some()),
            backings: battle.map(|b| {
                (0..b.community_count())
                    .filter_map(|i| {
                        let asset = b.community_asset(i)?;
                        let approval = b.backing_of(i);
                        Some(BackingReadinessV1 {
                            community: i as u32,
                            representation: asset.representation.clone(),
                            trusted: self
                                .lifecycle_trusted_representations
                                .get(&asset.representation)
                                .copied()
                                .unwrap_or(false),
                            asset_matches: approval.is_some_and(|a| a.asset == *asset),
                            evidence_hash: approval.map(|a| a.evidence_hash.clone()),
                            expires_at_ms: approval.map(|a| U64(a.expires_at_ms)),
                            fresh: approval.is_some_and(|a| now < a.expires_at_ms),
                        })
                    })
                    .collect()
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{json_types::U128, test_utils::VMContextBuilder, testing_env};

    #[test]
    fn application_views_preserve_large_ids_and_expose_real_activation_blocker() {
        testing_env!(VMContextBuilder::new().block_height(u64::MAX).build());
        let mut arena = Arena::new(
            "owner.testnet".parse().expect("account"),
            "usdc.testnet".parse().expect("account"),
            "treasury.testnet".parse().expect("account"),
            U128(0),
            U64(60),
        );
        arena.lifecycle_battle_count = u64::MAX;
        arena.battle_count = 1;
        arena.paused = true;
        let json = near_sdk::serde_json::to_value(arena.get_lifecycle_battle_count_v1())
            .expect("serialize");
        assert_eq!(json, u64::MAX.to_string());
        let state = arena.get_lifecycle_readiness_v1(Some(U64(u64::MAX)));
        assert!(state.paused && state.activation_blocked_by_legacy && !state.activated);
        assert_eq!(state.battle_found, Some(false));
        assert!(state.backings.is_none());
        let json = near_sdk::serde_json::to_value(state).expect("serialize");
        assert_eq!(json["block_height"], u64::MAX.to_string());
        assert_eq!(arena.get_lifecycle_battle_count(), u64::MAX);
        assert!(arena.get_lifecycle_battle_v1(U64(u64::MAX)).is_none());
    }
}
