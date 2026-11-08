//! Permissionless, batched settlement of a battle's losing vaults.
//!
//! Anyone may call `settle_lifecycle_battle` once a unique winner is recorded.
//! The caller cannot influence the result: the plan is recomputed from the
//! frozen snapshot, the recorded winner and the credited positions, and every
//! entitlement has a deterministic identity that the backing records at most
//! once. A batch advances the cursor only if every backing call succeeded, so
//! a failed or partial batch is simply repeated.
use crate::lifecycle::LifecycleError;
use crate::settlement::allocate_battle;
use crate::{Arena, ArenaExt};
use near_sdk::json_types::U64;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue,
};

/// Forwarded with each backing call to pay for the entitlement's storage. The
/// backing refunds what it does not use to this contract.
pub(crate) const ENTITLEMENT_DEPOSIT: NearToken = NearToken::from_millinear(10);
const ALLOCATE_GAS: Gas = Gas::from_tgas(12);
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
/// Keeps `MAX_BATCH * ALLOCATE_GAS + CALLBACK_GAS` well inside one transaction.
const MAX_BATCH: u32 = 15;

#[ext_contract(ext_backing_allocation)]
#[allow(dead_code)]
trait BackingAllocation {
    fn allocate_entitlement(
        &mut self,
        allocation_id: [u8; 32],
        beneficiary: AccountId,
        amount: near_sdk::json_types::U128,
    ) -> bool;
}

/// One entitlement to record in the backing of its losing token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedEntitlement {
    pub backing: AccountId,
    pub id: [u8; 32],
    pub beneficiary: AccountId,
    pub amount: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementProgress {
    pub recorded: u32,
    pub total: u32,
}

impl Arena {
    /// Every entitlement of the battle in a fixed order: losing communities by
    /// index, and within each the winners, then creator and protocol.
    pub fn settlement_plan(&self, id: u64) -> Result<Vec<PlannedEntitlement>, LifecycleError> {
        let battle = self
            .lifecycle_battles
            .get(&id)
            .ok_or(LifecycleError::UnknownBattle)?;
        let hold = battle
            .principal_hold()
            .ok_or(LifecycleError::WinnerNotResolved)?;
        let winners = self.lifecycle_participant_positions(id, hold.community);
        let allocations =
            allocate_battle(id, battle, &winners).map_err(|_| LifecycleError::InvalidAmount)?;
        let mut plan = Vec::new();
        for allocation in allocations {
            let backing = battle
                .losing_vault(allocation.community)?
                .asset
                .representation;
            for entitlement in allocation.entitlements {
                plan.push(PlannedEntitlement {
                    backing: backing.clone(),
                    id: entitlement.id,
                    beneficiary: entitlement.beneficiary,
                    amount: entitlement.amount,
                });
            }
        }
        Ok(plan)
    }
}

#[near]
impl Arena {
    /// Hand the next batch of entitlements to the backing contracts. The caller
    /// attaches `ENTITLEMENT_DEPOSIT` for each one; the rest is refunded.
    /// Returns the number of entitlements recorded so far.
    #[payable]
    pub fn settle_lifecycle_battle(
        &mut self,
        battle_id: U64,
        max_entitlements: u32,
    ) -> PromiseOrValue<u32> {
        require!(!self.paused, "Arena is paused");
        require!(
            (1..=MAX_BATCH).contains(&max_entitlements),
            "Batch size must be between 1 and 15"
        );
        let plan = self
            .settlement_plan(battle_id.0)
            .unwrap_or_else(|error| env::panic_str(&format!("Cannot settle: {error:?}")));
        let cursor = self
            .lifecycle_settlement
            .get(&battle_id.0)
            .copied()
            .unwrap_or(0) as usize;
        let attached = env::attached_deposit();
        let caller = env::predecessor_account_id();
        if cursor >= plan.len() {
            if !attached.is_zero() {
                Promise::new(caller).transfer(attached).detach();
            }
            return PromiseOrValue::Value(plan.len() as u32);
        }
        let end = plan.len().min(cursor + max_entitlements as usize);
        let needed = ENTITLEMENT_DEPOSIT
            .as_yoctonear()
            .checked_mul((end - cursor) as u128)
            .unwrap_or_else(|| env::panic_str("Deposit overflow"));
        require!(
            attached.as_yoctonear() >= needed,
            "Insufficient settlement deposit"
        );
        if attached.as_yoctonear() > needed {
            Promise::new(caller)
                .transfer(NearToken::from_yoctonear(attached.as_yoctonear() - needed))
                .detach();
        }
        let mut joined: Option<Promise> = None;
        for item in &plan[cursor..end] {
            let call = ext_backing_allocation::ext(item.backing.clone())
                .with_static_gas(ALLOCATE_GAS)
                .with_attached_deposit(ENTITLEMENT_DEPOSIT)
                .allocate_entitlement(item.id, item.beneficiary.clone(), item.amount.into());
            joined = Some(match joined {
                None => call,
                Some(previous) => previous.and(call),
            });
        }
        let joined = joined.unwrap_or_else(|| env::panic_str("Empty batch"));
        PromiseOrValue::Promise(
            joined.then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_settle_batch(battle_id, cursor as u32, end as u32),
            ),
        )
    }

    /// Advance the cursor only when this batch started where the cursor is and
    /// every backing call succeeded. Otherwise nothing changes and the batch can
    /// be repeated: the backing records each allocation id at most once.
    #[private]
    pub fn on_settle_batch(&mut self, battle_id: U64, from: u32, to: u32) -> u32 {
        // Each backing call returns a one-byte boolean; anything larger is rejected.
        let all_succeeded = (0..env::promise_results_count())
            .all(|index| env::promise_result_checked(index, 8).is_ok());
        let current = self
            .lifecycle_settlement
            .get(&battle_id.0)
            .copied()
            .unwrap_or(0);
        if all_succeeded && current == from {
            self.lifecycle_settlement.insert(battle_id.0, to);
            return to;
        }
        current
    }

    pub fn get_settlement_progress(&self, battle_id: U64) -> Option<SettlementProgress> {
        let plan = self.settlement_plan(battle_id.0).ok()?;
        Some(SettlementProgress {
            recorded: self
                .lifecycle_settlement
                .get(&battle_id.0)
                .copied()
                .unwrap_or(0),
            total: plan.len() as u32,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rounds_api::tests::locked_arena;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, PromiseResult};

    fn account(name: &str) -> AccountId {
        name.parse().expect("account")
    }
    fn caller(name: &str, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(account(name))
            .attached_deposit(deposit)
            .build());
    }
    fn panics<F: FnOnce()>(f: F) -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
    }

    #[test]
    fn participants_are_enumerated_and_the_plan_covers_every_losing_vault() {
        let mut arena = locked_arena();
        // Before a winner is recorded nothing can be planned or settled.
        assert!(arena.settlement_plan(1).is_err());
        assert!(arena.get_settlement_progress(U64(1)).is_none());
        caller("anyone.testnet", ENTITLEMENT_DEPOSIT);
        assert!(panics(|| {
            let _ = arena.settle_lifecycle_battle(U64(1), 5);
        }));
        arena.lifecycle_hold_principal(1, 0).expect("winner");
        assert_eq!(
            arena.lifecycle_participant_positions(1, 0),
            vec![(account("creator.testnet"), 10)]
        );
        let plan = arena.settlement_plan(1).expect("plan");
        // The eliminated community (2) settles like any other losing vault.
        assert_eq!(
            plan.iter()
                .map(|e| (e.backing.to_string(), e.beneficiary.to_string(), e.amount))
                .collect::<Vec<_>>(),
            vec![
                (
                    "token2.testnet".to_string(),
                    "creator.testnet".to_string(),
                    10
                ),
                (
                    "token3.testnet".to_string(),
                    "creator.testnet".to_string(),
                    10
                ),
            ]
        );
        assert_eq!(plan, arena.settlement_plan(1).expect("again"));
        let progress = arena.get_settlement_progress(U64(1)).expect("progress");
        assert_eq!((progress.recorded, progress.total), (0, 2));
    }

    #[test]
    fn batch_size_and_deposit_are_checked_and_a_finished_battle_refunds() {
        let mut arena = locked_arena();
        arena.lifecycle_hold_principal(1, 0).expect("winner");
        let two = NearToken::from_yoctonear(ENTITLEMENT_DEPOSIT.as_yoctonear() * 2);
        caller("anyone.testnet", two);
        assert!(panics(|| {
            let _ = arena.settle_lifecycle_battle(U64(1), 0);
        }));
        assert!(panics(|| {
            let _ = arena.settle_lifecycle_battle(U64(1), MAX_BATCH + 1);
        }));
        caller("anyone.testnet", ENTITLEMENT_DEPOSIT);
        assert!(panics(|| {
            let _ = arena.settle_lifecycle_battle(U64(1), 2);
        }));
        caller("anyone.testnet", two);
        assert!(matches!(
            arena.settle_lifecycle_battle(U64(1), 2),
            PromiseOrValue::Promise(_)
        ));
    }

    #[test]
    fn cursor_advances_only_after_a_fully_successful_batch_that_starts_at_the_cursor() {
        let mut arena = locked_arena();
        let ctx = || {
            VMContextBuilder::new()
                .predecessor_account_id(account("owner.testnet"))
                .build()
        };
        let with = |results: Vec<PromiseResult>| {
            testing_env!(
                ctx(),
                near_sdk::test_vm_config(),
                near_sdk::RuntimeFeesConfig::test(),
                Default::default(),
                results
            )
        };
        let ok = || PromiseResult::Successful(vec![1]);
        // A failed call anywhere in the batch leaves the cursor where it was.
        with(vec![ok(), PromiseResult::Failed]);
        assert_eq!(arena.on_settle_batch(U64(1), 0, 2), 0);
        // A batch that does not start at the cursor cannot move it.
        with(vec![ok(), ok()]);
        assert_eq!(arena.on_settle_batch(U64(1), 1, 2), 0);
        assert_eq!(arena.on_settle_batch(U64(1), 0, 2), 2);
        // A repeated or stale callback cannot move it backwards or past a later batch.
        with(vec![ok()]);
        assert_eq!(arena.on_settle_batch(U64(1), 0, 1), 2);
        assert_eq!(arena.lifecycle_settlement.get(&1).copied(), Some(2));
    }
}
