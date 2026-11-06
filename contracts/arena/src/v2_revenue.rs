//! Revenue configuration for the new arena, independent of legacy settlement.
//! Creation-time battle snapshots must copy this policy before accepting deposits.

use crate::{events, math::mul_div_floor, Arena, ArenaExt};
use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require};

const DENOMINATOR: u128 = 10_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RevenuePolicy {
    pub version: u64,
    pub total_fee_bps: u16,
    pub creator_share_bps: u16,
}

impl Default for RevenuePolicy {
    fn default() -> Self {
        Self {
            version: 1,
            total_fee_bps: 10,
            creator_share_bps: 5000,
        }
    }
}

/// JSON views preserve the complete u64 version without JavaScript rounding.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RevenuePolicyView {
    pub version: U64,
    pub total_fee_bps: u16,
    pub creator_share_bps: u16,
}

impl From<RevenuePolicy> for RevenuePolicyView {
    fn from(policy: RevenuePolicy) -> Self {
        Self {
            version: U64(policy.version),
            total_fee_bps: policy.total_fee_bps,
            creator_share_bps: policy.creator_share_bps,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RevenueError {
    InvalidBasisPoints,
    InvalidVersion,
    Overflow,
}

impl RevenueError {
    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidBasisPoints => "Revenue basis points must be between 0 and 10000",
            Self::InvalidVersion => "Revenue policy version must be positive",
            Self::Overflow => "Revenue arithmetic overflow",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeeAllocation {
    pub winner_pool: u128,
    pub total_fee: u128,
    pub creator_fee: u128,
    pub protocol_fee: u128,
}

impl RevenuePolicy {
    pub fn validate(&self) -> Result<(), RevenueError> {
        if self.version == 0 {
            return Err(RevenueError::InvalidVersion);
        }
        if u128::from(self.total_fee_bps) > DENOMINATOR
            || u128::from(self.creator_share_bps) > DENOMINATOR
        {
            return Err(RevenueError::InvalidBasisPoints);
        }
        Ok(())
    }

    /// Produces a new policy without mutating the original creation snapshot.
    pub fn updated(
        &self,
        total_fee_bps: u16,
        creator_share_bps: u16,
    ) -> Result<Self, RevenueError> {
        self.validate()?;
        if u128::from(total_fee_bps) > DENOMINATOR || u128::from(creator_share_bps) > DENOMINATOR {
            return Err(RevenueError::InvalidBasisPoints);
        }
        let version = self.version.checked_add(1).ok_or(RevenueError::Overflow)?;
        Ok(Self {
            version,
            total_fee_bps,
            creator_share_bps,
        })
    }

    /// Per-asset units only. Protocol creator status must come from authenticated
    /// battle state, never an untrusted user-selected flag at settlement time.
    pub fn allocate(
        &self,
        loser_vault: u128,
        protocol_created: bool,
    ) -> Result<FeeAllocation, RevenueError> {
        self.validate()?;
        let total_fee = mul_div_floor(loser_vault, u128::from(self.total_fee_bps), DENOMINATOR)
            .map_err(|_| RevenueError::Overflow)?;
        let creator_fee = if protocol_created {
            0
        } else {
            mul_div_floor(total_fee, u128::from(self.creator_share_bps), DENOMINATOR)
                .map_err(|_| RevenueError::Overflow)?
        };
        let winner_pool = loser_vault
            .checked_sub(total_fee)
            .ok_or(RevenueError::Overflow)?;
        let protocol_fee = total_fee
            .checked_sub(creator_fee)
            .ok_or(RevenueError::Overflow)?;
        Ok(FeeAllocation {
            winner_pool,
            total_fee,
            creator_fee,
            protocol_fee,
        })
    }
}

#[near]
impl Arena {
    pub fn get_revenue_policy(&self) -> RevenuePolicyView {
        self.v2_revenue.into()
    }

    /// Updates only the default policy for subsequently created v2 battles.
    /// This does not alter legacy settlement or already snapshotted policies.
    pub fn set_revenue_policy(&mut self, total_fee_bps: u16, creator_share_bps: u16) {
        let actor = env::predecessor_account_id();
        require!(actor == self.owner, "Protocol authority required");
        let previous = self.v2_revenue;
        let current = match previous.updated(total_fee_bps, creator_share_bps) {
            Ok(policy) => policy,
            Err(error) => env::panic_str(error.message()),
        };
        self.v2_revenue = current;
        events::emit(
            "revenue_policy_updated",
            json!({
                "actor": actor,
                "previous": RevenuePolicyView::from(previous),
                "current": RevenuePolicyView::from(current),
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::json_types::U128;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::{testing_env, AccountId};

    fn account(value: &str) -> AccountId {
        value.parse().unwrap()
    }
    fn context(predecessor: &str) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("arena.testnet"))
            .predecessor_account_id(account(predecessor))
            .build());
    }
    fn arena() -> Arena {
        context("owner.testnet");
        Arena::new(
            account("owner.testnet"),
            account("usdc.testnet"),
            account("treasury.testnet"),
            U128(5_000_000),
            U64(300),
        )
    }

    #[test]
    fn defaults_and_owner_update_emit_versioned_event() {
        let mut arena = arena();
        assert_eq!(arena.get_revenue_policy().version, U64(1));
        assert_eq!(arena.get_revenue_policy().total_fee_bps, 10);
        assert_eq!(arena.get_revenue_policy().creator_share_bps, 5000);
        arena.set_revenue_policy(200, 2500);
        assert_eq!(arena.get_revenue_policy().version, U64(2));
        let logs = get_logs();
        let event: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(
            logs.last().unwrap().strip_prefix("EVENT_JSON:").unwrap(),
        )
        .unwrap();
        assert_eq!(event["standard"], "valtrum");
        assert_eq!(event["event"], "revenue_policy_updated");
        assert_eq!(event["data"][0]["actor"], "owner.testnet");
        assert_eq!(event["data"][0]["previous"]["version"], "1");
        assert_eq!(event["data"][0]["current"]["version"], "2");
        assert_eq!(event["data"][0]["current"]["total_fee_bps"], 200);
    }

    #[test]
    #[should_panic(expected = "Protocol authority required")]
    fn unauthorized_update_fails() {
        let mut arena = arena();
        context("stranger.testnet");
        arena.set_revenue_policy(10000, 10000);
    }

    #[test]
    #[should_panic(expected = "between 0 and 10000")]
    fn invalid_total_fee_fails() {
        arena().set_revenue_policy(10001, 5000);
    }

    #[test]
    #[should_panic(expected = "between 0 and 10000")]
    fn invalid_creator_share_fails() {
        arena().set_revenue_policy(10, 10001);
    }

    #[test]
    fn policy_update_preserves_copied_creation_snapshot() {
        let mut arena = arena();
        let snapshot = arena.v2_revenue;
        arena.set_revenue_policy(200, 2500);
        assert_eq!(
            snapshot.allocate(100000, false).unwrap(),
            FeeAllocation {
                winner_pool: 99900,
                total_fee: 100,
                creator_fee: 50,
                protocol_fee: 50
            }
        );
        assert_eq!(
            arena.v2_revenue.allocate(100000, false).unwrap(),
            FeeAllocation {
                winner_pool: 98000,
                total_fee: 2000,
                creator_fee: 500,
                protocol_fee: 1500
            }
        );
    }

    #[test]
    fn tiny_and_odd_fee_units_are_conserved() {
        let policy = RevenuePolicy::default();
        assert_eq!(
            policy.allocate(999, false).unwrap(),
            FeeAllocation {
                winner_pool: 999,
                total_fee: 0,
                creator_fee: 0,
                protocol_fee: 0
            }
        );
        assert_eq!(
            policy.allocate(1000, false).unwrap(),
            FeeAllocation {
                winner_pool: 999,
                total_fee: 1,
                creator_fee: 0,
                protocol_fee: 1
            }
        );
    }

    #[test]
    fn all_boundaries_and_large_u128_values_are_conserved() {
        for fee in [0, 1, 10, 3333, 10000] {
            for share in [0, 1, 5000, 9999, 10000] {
                let policy = RevenuePolicy {
                    version: 1,
                    total_fee_bps: fee,
                    creator_share_bps: share,
                };
                for vault in [0, 1, 999, 1000, 10003, 100000, u128::MAX] {
                    for protocol_created in [false, true] {
                        let split = policy.allocate(vault, protocol_created).unwrap();
                        assert_eq!(split.winner_pool.checked_add(split.total_fee), Some(vault));
                        assert_eq!(
                            split.creator_fee.checked_add(split.protocol_fee),
                            Some(split.total_fee)
                        );
                        if protocol_created {
                            assert_eq!(split.creator_fee, 0);
                        }
                        if fee == 0 {
                            assert_eq!(split.winner_pool, vault);
                        }
                        if fee == 10000 {
                            assert_eq!(split.winner_pool, 0);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn invalid_policy_and_version_exhaustion_fail_without_wrapping() {
        let exhausted = RevenuePolicy {
            version: u64::MAX,
            ..RevenuePolicy::default()
        };
        assert_eq!(exhausted.updated(10, 5000), Err(RevenueError::Overflow));
        assert_eq!(
            RevenuePolicy::default().updated(u16::MAX, 5000),
            Err(RevenueError::InvalidBasisPoints)
        );
        assert_eq!(
            RevenuePolicy::default().updated(10, u16::MAX),
            Err(RevenueError::InvalidBasisPoints)
        );
        assert_eq!(
            RevenuePolicy {
                version: 0,
                ..RevenuePolicy::default()
            }
            .allocate(1, false),
            Err(RevenueError::InvalidVersion)
        );
    }
}
