//! Creator escrow unit tests (D41): a battle exists only with its creator's deposit, held apart from the
//! vaults until the community is approved. Fixtures stand in for audit and backing; they are not live evidence.

use crate::lifecycle::{AuditResult, BackingApproval};
use crate::open_arena_tests::{
    account, approve, ctx, deposit, join, list, lock, panics, setup, vault, DAY_MS, FAR, NOW_MS,
};
use crate::Arena;
use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken, PromiseError, PromiseOrValue, PromiseResult};

const CREATOR: &str = "creator.testnet";
const START: u64 = NOW_MS + DAY_MS;

fn prepay(arena: &mut Arena, who: &str, near: u128) {
    ctx(who, NearToken::from_near(near), NOW_MS);
    arena.lifecycle_storage_deposit(None);
}

/// The token calls `ft_on_transfer` with a `lifecycle_create` message; returns the unused amount.
fn send_create(arena: &mut Arena, who: &str, token_index: u32, amount: u128, start: u64) -> u128 {
    ctx(
        &format!("token{token_index}.testnet"),
        NearToken::from_yoctonear(0),
        NOW_MS,
    );
    let msg =
        format!(r#"{{"action":"lifecycle_create","mode":"PriceGain","start_at_ms":"{start}"}}"#);
    match arena.ft_on_transfer(account(who), U128(amount), msg) {
        PromiseOrValue::Value(unused) => unused.0,
        PromiseOrValue::Promise(_) => panic!("unexpected promise"),
    }
}

/// An activated arena whose token1 is joinable and whose creator prepaid storage.
fn ready() -> Arena {
    let mut arena = setup();
    for index in 1..=3 {
        list(&mut arena, index);
    }
    prepay(&mut arena, CREATOR, 1);
    arena
}

/// Battle 1 created by the creator with 100 of token1.
fn created() -> (Arena, u64) {
    let mut arena = ready();
    assert_eq!(send_create(&mut arena, CREATOR, 1, 100, START), 0);
    (arena, 1)
}

fn approve_creator_audit_only(arena: &mut Arena, id: u64) {
    let asset = arena
        .lifecycle_battles
        .get(&id)
        .and_then(|b| b.community_asset(0).cloned())
        .expect("community");
    arena
        .lifecycle_set_backing(
            id,
            0,
            Some(BackingApproval {
                asset,
                evidence_hash: "backing".into(),
                expires_at_ms: FAR,
            }),
        )
        .expect("backing");
}

fn position(arena: &Arena, id: u64, community: u32, who: &str) -> (bool, u128) {
    let view = arena.get_lifecycle_position(id, community, account(who));
    (view.registered, view.amount.0)
}

// ---- creation ----

#[test]
fn a_deposit_creates_the_battle_registers_the_creator_and_holds_the_escrow() {
    let (arena, id) = created();
    assert_eq!(arena.get_lifecycle_battle_count(), 1);
    let battle = arena.get_lifecycle_battle(id).expect("battle");
    assert_eq!(battle.communities.len(), 1);
    assert_eq!(
        battle.communities[0].representation,
        account("token1.testnet")
    );
    // The creator is registered but holds no credited position, and the vault is empty.
    assert_eq!(position(&arena, id, 0, CREATOR), (true, 0));
    assert_eq!(vault(&arena, id, 0), 0);
    let escrow = arena.get_lifecycle_creator_escrow(id).expect("escrow");
    assert_eq!(escrow.creator, account(CREATOR));
    assert_eq!(escrow.representation, account("token1.testnet"));
    assert_eq!(escrow.amount, U128(100));
    assert!(!escrow.credited);
    assert_eq!(arena.get_lifecycle_start(id), Some(U64(START)));
    let logs = get_logs().join("\n");
    assert!(logs.contains("lifecycle_battle_created"));
    assert!(logs.contains("lifecycle_creator_escrow_held"));
}

#[test]
fn a_refused_creation_returns_the_whole_transfer_and_changes_nothing() {
    let mut arena = ready();
    // Zero units, a token that is not on the allowlist and a start time out of range.
    assert_eq!(send_create(&mut arena, CREATOR, 1, 0, START), 0);
    assert_eq!(send_create(&mut arena, CREATOR, 9, 5, START), 5);
    assert_eq!(send_create(&mut arena, CREATOR, 1, 5, NOW_MS + 1_000), 5);
    assert_eq!(
        send_create(&mut arena, CREATOR, 1, 5, NOW_MS + 8 * DAY_MS),
        5
    );
    assert_eq!(arena.get_lifecycle_battle_count(), 0);
    assert!(arena.get_lifecycle_creator_escrow(1).is_none());
    // The prepaid balance is untouched.
    assert_eq!(
        arena.get_lifecycle_storage_balance(account(CREATOR)),
        U128(NearToken::from_near(1).as_yoctonear())
    );
}

#[test]
fn creation_is_refused_while_the_arena_is_paused() {
    let mut arena = ready();
    ctx("owner.testnet", NearToken::from_yoctonear(1), NOW_MS);
    arena.set_paused(true);
    assert_eq!(send_create(&mut arena, CREATOR, 1, 100, START), 100);
    assert_eq!(arena.get_lifecycle_battle_count(), 0);
}

#[test]
fn the_old_create_method_creates_nothing() {
    let mut arena = ready();
    ctx(CREATOR, NearToken::from_near(1), NOW_MS);
    assert!(panics(|| {
        arena.create_lifecycle_battle(
            vec![],
            crate::lifecycle::ScoringMode::PriceGain,
            Some(U64(START)),
        );
    }));
    assert_eq!(arena.get_lifecycle_battle_count(), 0);
}

// ---- prepaid storage ----

// A panicking call keeps its writes in the unit-test mock (on chain it reverts), so each refusal below is
// its own test with its own mock storage.
#[test]
fn creation_without_any_prepaid_storage_is_refused() {
    let mut arena = setup();
    list(&mut arena, 1);
    assert!(panics(|| {
        send_create(&mut arena, CREATOR, 1, 100, START);
    }));
}

#[test]
fn creation_with_a_balance_that_cannot_cover_the_storage_is_refused() {
    let mut arena = setup();
    list(&mut arena, 1);
    ctx(CREATOR, NearToken::from_yoctonear(1), NOW_MS);
    arena.lifecycle_storage_deposit(None);
    assert!(panics(|| {
        send_create(&mut arena, CREATOR, 1, 100, START);
    }));
}

#[test]
fn creation_deducts_only_the_measured_storage_and_the_rest_is_withdrawable() {
    let (mut arena, _) = created();
    let balance = arena.get_lifecycle_storage_balance(account(CREATOR)).0;
    let prepaid = NearToken::from_near(1).as_yoctonear();
    assert!(balance < prepaid, "storage was charged");
    assert!(balance > 0, "only the measured storage was charged");
    ctx(CREATOR, NearToken::from_yoctonear(1), NOW_MS);
    assert_eq!(
        arena.lifecycle_storage_withdraw(Some(U128(balance))),
        U128(balance)
    );
    assert_eq!(
        arena.get_lifecycle_storage_balance(account(CREATOR)),
        U128(0)
    );
    // Nothing is left to take, and nobody can take another account's balance.
    ctx(CREATOR, NearToken::from_yoctonear(1), NOW_MS);
    assert!(panics(|| {
        arena.lifecycle_storage_withdraw(None);
    }));
    ctx("other.testnet", NearToken::from_yoctonear(1), NOW_MS);
    assert!(panics(|| {
        arena.lifecycle_storage_withdraw(Some(U128(1)));
    }));
}

#[test]
fn withdrawing_storage_needs_one_yocto() {
    let (mut arena, _) = created();
    ctx(CREATOR, NearToken::from_yoctonear(0), NOW_MS);
    assert!(panics(|| {
        arena.lifecycle_storage_withdraw(None);
    }));
}

// ---- conversion ----

#[test]
fn the_escrow_stays_held_until_both_approvals_exist_and_never_counts_as_funded() {
    let (mut arena, id) = created();
    // No approval: nothing converts.
    assert!(!arena.lifecycle_convert_creator_escrow(id));
    // Backing only: still held.
    approve_creator_audit_only(&mut arena, id);
    assert!(!arena.lifecycle_convert_creator_escrow(id));
    assert_eq!(vault(&arena, id, 0), 0);
    assert!(arena.get_lifecycle_creator_escrow(id).is_some());
    assert!(arena
        .lifecycle_battles
        .get(&id)
        .expect("battle")
        .funded_indices()
        .is_empty());
}

#[test]
fn both_approvals_turn_the_escrow_into_the_creators_position_and_vault() {
    let (mut arena, id) = created();
    approve(&mut arena, id, 0);
    assert!(arena.lifecycle_convert_creator_escrow(id));
    assert_eq!(position(&arena, id, 0, CREATOR), (true, 100));
    assert_eq!(vault(&arena, id, 0), 100);
    assert!(arena.get_lifecycle_creator_escrow(id).is_none());
    assert!(get_logs()
        .join("\n")
        .contains("lifecycle_creator_escrow_credited"));
    // A second conversion changes nothing.
    assert!(!arena.lifecycle_convert_creator_escrow(id));
    assert_eq!(vault(&arena, id, 0), 100);
}

#[test]
fn the_audit_call_converts_when_the_backing_is_already_there() {
    let (mut arena, id) = created();
    approve_creator_audit_only(&mut arena, id);
    ctx("worker.testnet", NearToken::from_near(1), NOW_MS);
    arena.submit_lifecycle_audit(
        id,
        0,
        crate::lifecycle::AssetInput::from(
            arena
                .lifecycle_battles
                .get(&id)
                .and_then(|b| b.community_asset(0).cloned())
                .expect("community"),
        ),
        AuditResult::Pass,
        "policy".into(),
        "audit".into(),
        Some(U64(NOW_MS + DAY_MS / 2)),
    );
    assert_eq!(position(&arena, id, 0, CREATOR), (true, 100));
    assert!(arena.get_lifecycle_creator_escrow(id).is_none());
}

#[test]
fn a_cancelled_battle_never_converts_its_escrow() {
    let (mut arena, id) = created();
    ctx("anyone.testnet", NearToken::from_yoctonear(0), START);
    arena.cancel_lifecycle_battle(id);
    approve(&mut arena, id, 0);
    assert!(!arena.lifecycle_convert_creator_escrow(id));
    assert!(arena.get_lifecycle_creator_escrow(id).is_some());
}

#[test]
fn the_lock_is_refused_while_the_creator_escrow_is_held() {
    let (mut arena, id) = created();
    // Two other funded communities, the creator's community approved but not converted.
    for (who, index) in [("alice.testnet", 2), ("bob.testnet", 3)] {
        join(&mut arena, who, id, index, NOW_MS);
    }
    for community in 1..=2 {
        approve(&mut arena, id, community);
    }
    assert_eq!(deposit(&mut arena, "alice.testnet", id, 1, 2, 5, NOW_MS), 0);
    assert_eq!(deposit(&mut arena, "bob.testnet", id, 2, 3, 5, NOW_MS), 0);
    // The escrow does not count: two funded communities, but the creator has no position.
    ctx("worker.testnet", NearToken::from_near(1), START);
    assert!(panics(|| arena.lock_lifecycle_battle(id, None)));
    // Once it converts, the same battle locks.
    approve(&mut arena, id, 0);
    assert!(arena.lifecycle_convert_creator_escrow(id));
    lock(&mut arena, id, None, START);
}

// ---- cancel and refund ----

/// Creator escrow held, two other communities funded, start time reached.
fn stuck() -> (Arena, u64) {
    let (mut arena, id) = created();
    for (who, index) in [("alice.testnet", 2), ("bob.testnet", 3)] {
        join(&mut arena, who, id, index, NOW_MS);
    }
    for community in 1..=2 {
        approve(&mut arena, id, community);
    }
    assert_eq!(deposit(&mut arena, "alice.testnet", id, 1, 2, 5, NOW_MS), 0);
    assert_eq!(deposit(&mut arena, "bob.testnet", id, 2, 3, 7, NOW_MS), 0);
    (arena, id)
}

#[test]
fn anyone_can_cancel_when_the_creator_escrow_is_still_held_even_with_two_funded_communities() {
    let (mut arena, id) = stuck();
    ctx("anyone.testnet", NearToken::from_yoctonear(0), START);
    arena.cancel_lifecycle_battle(id);
    assert!(arena.is_lifecycle_cancelled(id));
}

#[test]
fn cancel_stays_refused_with_two_funded_communities_once_the_creator_is_credited() {
    let (mut arena, id) = stuck();
    approve(&mut arena, id, 0);
    assert!(arena.lifecycle_convert_creator_escrow(id));
    ctx("anyone.testnet", NearToken::from_yoctonear(0), START);
    assert!(panics(|| arena.cancel_lifecycle_battle(id)));
}

fn escrow_callback(arena: &mut Arena, failed: bool, id: u64, amount: u128) -> bool {
    let result = if failed {
        PromiseResult::Failed
    } else {
        PromiseResult::Successful(vec![])
    };
    testing_env!(
        VMContextBuilder::new()
            .predecessor_account_id(account("arena.testnet"))
            .current_account_id(account("arena.testnet"))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
    let outcome = if failed {
        Err(PromiseError::Failed)
    } else {
        Ok(())
    };
    arena.on_lifecycle_escrow_refund(
        id,
        account(CREATOR),
        account("token1.testnet"),
        U128(amount),
        outcome,
    )
}

#[test]
fn the_creator_claims_the_escrow_back_after_a_cancel_and_it_cannot_repeat() {
    let (mut arena, id) = stuck();
    ctx("anyone.testnet", NearToken::from_yoctonear(0), START);
    arena.cancel_lifecycle_battle(id);
    // Not before a cancel, only by the creator and only with one yocto.
    ctx("other.testnet", NearToken::from_yoctonear(1), START);
    assert!(panics(|| {
        let _ = arena.claim_lifecycle_escrow_refund(id);
    }));
    ctx(CREATOR, NearToken::from_yoctonear(0), START);
    assert!(panics(|| {
        let _ = arena.claim_lifecycle_escrow_refund(id);
    }));
    ctx(CREATOR, NearToken::from_yoctonear(1), START);
    let _ = arena.claim_lifecycle_escrow_refund(id);
    // The escrow is already gone while the transfer is in flight, so a second claim pays nothing.
    assert!(arena.get_lifecycle_creator_escrow(id).is_none());
    ctx(CREATOR, NearToken::from_yoctonear(1), START);
    assert!(panics(|| {
        let _ = arena.claim_lifecycle_escrow_refund(id);
    }));
    assert!(escrow_callback(&mut arena, false, id, 100));
    assert!(get_logs()
        .join("\n")
        .contains("lifecycle_creator_escrow_refunded"));
    assert!(arena.get_lifecycle_creator_escrow(id).is_none());
}

#[test]
fn a_failed_escrow_refund_restores_the_escrow() {
    let (mut arena, id) = stuck();
    ctx("anyone.testnet", NearToken::from_yoctonear(0), START);
    arena.cancel_lifecycle_battle(id);
    ctx(CREATOR, NearToken::from_yoctonear(1), START);
    let _ = arena.claim_lifecycle_escrow_refund(id);
    assert!(!escrow_callback(&mut arena, true, id, 100));
    let escrow = arena.get_lifecycle_creator_escrow(id).expect("restored");
    assert_eq!(escrow.amount, U128(100));
    assert!(get_logs()
        .join("\n")
        .contains("lifecycle_creator_escrow_refund_failed"));
}

#[test]
fn the_escrow_refund_is_only_for_a_cancelled_battle() {
    let (mut arena, id) = created();
    ctx(CREATOR, NearToken::from_yoctonear(1), NOW_MS);
    assert!(panics(|| {
        let _ = arena.claim_lifecycle_escrow_refund(id);
    }));
}

// ---- earlier battles ----

#[test]
fn a_battle_created_without_an_escrow_reads_as_having_none_and_keeps_the_old_cancel_rule() {
    let mut arena = ready();
    ctx(CREATOR, NearToken::from_near(1), NOW_MS);
    let id = arena.create_lifecycle_battle_for_tests(
        vec![],
        crate::lifecycle::ScoringMode::PriceGain,
        Some(U64(START)),
    );
    assert!(arena.get_lifecycle_creator_escrow(id).is_none());
    assert!(!arena.lifecycle_has_held_escrow(id));
    for (who, index) in [("alice.testnet", 2), ("bob.testnet", 3)] {
        join(&mut arena, who, id, index, NOW_MS);
    }
    for community in 0..=1 {
        approve(&mut arena, id, community);
    }
    assert_eq!(deposit(&mut arena, "alice.testnet", id, 0, 2, 5, NOW_MS), 0);
    assert_eq!(deposit(&mut arena, "bob.testnet", id, 1, 3, 5, NOW_MS), 0);
    ctx("anyone.testnet", NearToken::from_yoctonear(0), START);
    assert!(panics(|| arena.cancel_lifecycle_battle(id)));
}
