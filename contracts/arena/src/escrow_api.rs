//! Exclusive backing reservation of a battle's winning principal (DAO escrow).
//!
//! Once the final winner is recorded, anyone may call
//! `reserve_lifecycle_escrow`. The arena asks the winning community's backing
//! to burn the arena's locked representations for that vault and move the same
//! backing into its exclusive `escrow` bucket, where it can no longer be
//! redeemed, disposed of, allocated or paid out. The caller cannot influence
//! the amount, asset or identity: they come from the recorded principal hold.
//!
//! This module adds no way out of escrow. The governance vote and its
//! execution (decision D22) are a separate integration (#75); until then the
//! principal stays escrowed indefinitely. Losing-token settlement never waits
//! for this reservation.
use crate::settlement::part;
use crate::{events, Arena, ArenaExt};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue,
};

/// Forwarded with the backing call to pay for the escrow record's storage. The
/// backing refunds what it does not use to this contract.
pub const ESCROW_DEPOSIT: NearToken = NearToken::from_millinear(10);
const ESCROW_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(15);

#[ext_contract(ext_backing_escrow)]
#[allow(dead_code)]
trait BackingEscrow {
    fn reserve_principal_escrow(
        &mut self,
        escrow_id: [u8; 32],
        battle_id: U64,
        community: u32,
        amount: U128,
    ) -> bool;
}

/// Deterministic escrow identity, bound to this arena, the battle and the
/// winning community, so a retry can never escrow twice or elsewhere.
pub fn escrow_id(arena: &AccountId, battle_id: u64, community: u32) -> [u8; 32] {
    let mut data = b"valtrum/escrow/v1".to_vec();
    part(&mut data, arena.as_str().as_bytes());
    part(&mut data, &battle_id.to_be_bytes());
    part(&mut data, &community.to_be_bytes());
    env::sha256_array(&data)
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EscrowView {
    /// Lowercase hex of the escrow id recorded in the backing.
    pub escrow_id: String,
    pub community: u32,
    pub representation: AccountId,
    pub amount: U128,
    /// True once the backing confirmed the exclusive reservation.
    pub reserved: bool,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[near]
impl Arena {
    /// Ask the winning community's backing to hold the whole winning vault in
    /// its exclusive escrow bucket. Permissionless; attach `ESCROW_DEPOSIT`, the
    /// rest is refunded. Returns true when the reservation is recorded.
    #[payable]
    pub fn reserve_lifecycle_escrow(&mut self, battle_id: U64) -> PromiseOrValue<bool> {
        require!(!self.paused, "Arena is paused");
        let hold = self
            .lifecycle_battles
            .get(&battle_id.0)
            .and_then(|battle| battle.principal_hold().cloned())
            .unwrap_or_else(|| env::panic_str("Cannot escrow: winner not resolved"));
        let attached = env::attached_deposit();
        let caller = env::predecessor_account_id();
        if self.lifecycle_escrow.get(&battle_id.0).copied() == Some(true) {
            if !attached.is_zero() {
                Promise::new(caller).transfer(attached).detach();
            }
            return PromiseOrValue::Value(true);
        }
        require!(hold.amount > 0, "Cannot escrow: empty winning vault");
        require!(attached >= ESCROW_DEPOSIT, "Insufficient escrow deposit");
        if attached > ESCROW_DEPOSIT {
            Promise::new(caller)
                .transfer(attached.saturating_sub(ESCROW_DEPOSIT))
                .detach();
        }
        let id = escrow_id(&env::current_account_id(), battle_id.0, hold.community);
        PromiseOrValue::Promise(
            ext_backing_escrow::ext(hold.asset.representation)
                .with_static_gas(ESCROW_GAS)
                .with_attached_deposit(ESCROW_DEPOSIT)
                .reserve_principal_escrow(id, battle_id, hold.community, U128(hold.amount))
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_reserve_escrow(battle_id),
                ),
        )
    }

    /// Records the reservation only when the backing answered with a boolean
    /// (true on first execution, false on an identical repeat). A failure
    /// changes nothing, so the call can be repeated.
    #[private]
    pub fn on_reserve_escrow(&mut self, battle_id: U64) -> bool {
        let answered = env::promise_result_checked(0, 8)
            .map(|bytes| bytes == b"true" || bytes == b"false")
            .unwrap_or(false);
        if !answered {
            return false;
        }
        if self.lifecycle_escrow.get(&battle_id.0).copied() != Some(true) {
            self.lifecycle_escrow.insert(battle_id.0, true);
            let hold = self
                .lifecycle_battles
                .get(&battle_id.0)
                .and_then(|battle| battle.principal_hold().cloned());
            if let Some(hold) = hold {
                events::emit(
                    "principal_escrowed",
                    json!({
                        "battle_id": battle_id,
                        "community": hold.community,
                        "representation": hold.asset.representation,
                        "amount": U128(hold.amount),
                    }),
                );
            }
        }
        true
    }

    /// Escrow state of the winning principal; None before a winner is recorded.
    pub fn get_lifecycle_escrow(&self, battle_id: U64) -> Option<EscrowView> {
        let hold = self
            .lifecycle_battles
            .get(&battle_id.0)?
            .principal_hold()?
            .clone();
        Some(EscrowView {
            escrow_id: hex(&escrow_id(
                &env::current_account_id(),
                battle_id.0,
                hold.community,
            )),
            community: hold.community,
            representation: hold.asset.representation,
            amount: U128(hold.amount),
            reserved: self.lifecycle_escrow.get(&battle_id.0).copied() == Some(true),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rounds_api::tests::locked_arena;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult};

    fn account(name: &str) -> AccountId {
        name.parse().expect("account")
    }
    fn caller(name: &str, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("arena.testnet"))
            .predecessor_account_id(account(name))
            .attached_deposit(deposit)
            .build());
    }
    fn callback(results: Vec<PromiseResult>) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(account("arena.testnet"))
                .predecessor_account_id(account("arena.testnet"))
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results
        );
    }
    fn panics<F: FnOnce()>(f: F) -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
    }

    #[test]
    fn escrow_needs_a_recorded_winner_and_the_deposit() {
        let mut arena = locked_arena();
        caller("anyone.testnet", ESCROW_DEPOSIT);
        assert!(panics(|| {
            let _ = arena.reserve_lifecycle_escrow(U64(1));
        }));
        assert!(arena.get_lifecycle_escrow(U64(1)).is_none());
        arena.lifecycle_hold_principal(1, 0).expect("winner");
        caller("anyone.testnet", NearToken::from_yoctonear(1));
        assert!(panics(|| {
            let _ = arena.reserve_lifecycle_escrow(U64(1));
        }));
        caller("anyone.testnet", ESCROW_DEPOSIT);
        assert!(matches!(
            arena.reserve_lifecycle_escrow(U64(1)),
            PromiseOrValue::Promise(_)
        ));
        // Nothing is recorded until the backing answers.
        let view = arena.get_lifecycle_escrow(U64(1)).expect("view");
        assert_eq!(
            (view.community, view.amount, view.reserved),
            (0, U128(10), false)
        );
        assert_eq!(view.representation, account("token1.testnet"));
    }

    #[test]
    fn only_a_backing_answer_records_the_reservation_once() {
        let mut arena = locked_arena();
        arena.lifecycle_hold_principal(1, 0).expect("winner");
        for failed in [
            PromiseResult::Failed,
            PromiseResult::Successful(b"\"x\"".to_vec()),
            PromiseResult::Successful(vec![0; 64]),
        ] {
            callback(vec![failed]);
            assert!(!arena.on_reserve_escrow(U64(1)));
        }
        caller("anyone.testnet", ESCROW_DEPOSIT);
        assert!(!arena.get_lifecycle_escrow(U64(1)).expect("view").reserved);
        callback(vec![PromiseResult::Successful(b"true".to_vec())]);
        assert!(arena.on_reserve_escrow(U64(1)));
        assert!(get_logs()
            .iter()
            .any(|line| line.contains("\"principal_escrowed\"")));
        // An identical repeat answers false; the state stays reserved, no new event.
        callback(vec![PromiseResult::Successful(b"false".to_vec())]);
        assert!(arena.on_reserve_escrow(U64(1)));
        assert!(get_logs().is_empty());
        caller("anyone.testnet", ESCROW_DEPOSIT);
        assert!(arena.get_lifecycle_escrow(U64(1)).expect("view").reserved);
        // A reserved battle refunds the deposit and does not call the backing again.
        assert!(matches!(
            arena.reserve_lifecycle_escrow(U64(1)),
            PromiseOrValue::Value(true)
        ));
    }

    #[test]
    fn escrow_identity_binds_arena_battle_and_community() {
        let arena = account("arena.testnet");
        let base = escrow_id(&arena, 1, 0);
        assert_eq!(base, escrow_id(&arena, 1, 0));
        assert_ne!(base, escrow_id(&arena, 2, 0));
        assert_ne!(base, escrow_id(&arena, 1, 1));
        assert_ne!(base, escrow_id(&account("other.testnet"), 1, 0));
    }

    #[test]
    fn the_callback_cannot_be_called_from_outside() {
        let mut arena = locked_arena();
        arena.lifecycle_hold_principal(1, 0).expect("winner");
        caller("attacker.testnet", NearToken::from_yoctonear(0));
        assert!(panics(|| {
            let _ = arena.on_reserve_escrow(U64(1));
        }));
    }

    #[test]
    fn losing_token_settlement_does_not_wait_for_escrow() {
        let mut arena = locked_arena();
        arena.lifecycle_hold_principal(1, 0).expect("winner");
        let two =
            NearToken::from_yoctonear(crate::settle_api::ENTITLEMENT_DEPOSIT.as_yoctonear() * 2);
        caller("anyone.testnet", two);
        assert!(matches!(
            arena.settle_lifecycle_battle(U64(1), 2),
            PromiseOrValue::Promise(_)
        ));
        assert!(!arena.get_lifecycle_escrow(U64(1)).expect("view").reserved);
    }
}
