//! Lifecycle guard tests: what stays frozen through live rounds and what
//! happens to the held principal. This module has no contract code.
//!
//! These tests use local mock-token calls only. They do not cover foreign-chain
//! arrivals, audit/backing integration or DAO disposition; none is defined here.

use crate::lifecycle::LifecycleError;
use crate::rounds_api::tests::locked_arena;
use crate::rounds_api::{CandidateObservationInput, ModeDataInput, RoundOutcome};
use crate::settle_api::PlannedEntitlement;
use crate::Arena;
use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, NearToken, PromiseOrValue};

const START: u64 = 1_000_000_000_000;
const ROUND: u64 = 30_000_000_000;

fn account(name: &str) -> AccountId {
    name.parse().expect("account")
}

fn context(caller: &str, deposit: NearToken, now: u64) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(account(caller))
        .attached_deposit(deposit)
        .block_timestamp(now)
        .build());
}

fn panics<F: FnOnce()>(f: F) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
}

fn observation(community: u32, end: u128, start: u64) -> CandidateObservationInput {
    CandidateObservationInput {
        community,
        observed_times_ns: vec![U64(start), U64(start + ROUND)],
        evidence_hash: "evidence".into(),
        data: ModeDataInput::Price {
            start: U128(100),
            end: U128(end),
        },
    }
}

fn token(index: u8) -> AccountId {
    account(&format!("token{index}.testnet"))
}

/// Every action that could change a locked battle, tried once. Returns the
/// transfer amount handed back for each late representation transfer.
fn try_every_change(arena: &mut Arena, now: u64) {
    let frozen = arena.lifecycle_battles.get(&1).expect("battle").clone();
    let positions_before: Vec<u128> = (0..3)
        .map(|c| {
            let who = if c == 0 { "creator" } else { "other" };
            arena.lifecycle_position(1, c, &account(&format!("{who}.testnet")))
        })
        .collect();
    let participants_before: Vec<_> = (0..3)
        .map(|c| arena.lifecycle_participant_positions(1, c))
        .collect();

    // Direct credits and every evidence change are refused.
    for community in 0..3u32 {
        assert_eq!(
            arena.lifecycle_credit(
                1,
                community,
                &token(community as u8 + 1),
                &account(if community == 0 {
                    "creator.testnet"
                } else {
                    "other.testnet"
                }),
                1
            ),
            Err(LifecycleError::Locked)
        );
        assert_eq!(
            arena.lifecycle_set_audit(1, community as usize, None),
            Err(LifecycleError::Locked)
        );
        assert_eq!(
            arena.lifecycle_set_backing(1, community as usize, None),
            Err(LifecycleError::Locked)
        );
        assert_eq!(
            arena.lifecycle_register_position(1, community, &account("late.testnet")),
            Err(LifecycleError::Locked)
        );
    }

    // A late representation transfer is returned in full through the NEP-141 receiver.
    for community in 0..3u32 {
        context(
            &format!("token{}.testnet", community + 1),
            NearToken::from_yoctonear(0),
            now,
        );
        let msg =
            format!(r#"{{"action":"lifecycle_deposit","battle_id":1,"community":{community}}}"#);
        match arena.ft_on_transfer(account("creator.testnet"), U128(5), msg) {
            PromiseOrValue::Value(unused) => assert_eq!(unused, U128(5)),
            PromiseOrValue::Promise(_) => panic!("unexpected promise"),
        }
    }

    // A repeated lock with a different policy returns the original snapshot.
    let original_policy = crate::lifecycle::ObservationPolicy {
        version: 1,
        policy_hash: "ignored".into(),
    };
    let policy = crate::lifecycle::ObservationPolicy {
        version: 9,
        policy_hash: "changed".into(),
    };
    let first = arena
        .lifecycle_lock(1, original_policy)
        .expect("repeat lock");
    let again = arena.lifecycle_lock(1, policy).expect("repeat lock");
    assert_eq!(
        again, first,
        "repeated lock must return the original snapshot"
    );

    // Nothing moved: battle record, positions and participant index are identical.
    assert_eq!(arena.lifecycle_battles.get(&1), Some(&frozen));
    let positions_after: Vec<u128> = (0..3)
        .map(|c| {
            let who = if c == 0 { "creator" } else { "other" };
            arena.lifecycle_position(1, c, &account(&format!("{who}.testnet")))
        })
        .collect();
    assert_eq!(positions_before, positions_after);
    let participants_after: Vec<_> = (0..3)
        .map(|c| arena.lifecycle_participant_positions(1, c))
        .collect();
    assert_eq!(participants_before, participants_after);
}

#[test]
fn deposits_and_snapshot_changes_stay_refused_through_live_rounds_and_overtime() {
    let mut arena = locked_arena();
    context("owner.testnet", NearToken::from_yoctonear(1), 0);
    arena.activate_lifecycle();

    // Locked, rounds not yet started.
    try_every_change(&mut arena, 0);

    context("anyone.testnet", NearToken::from_near(1), 0);
    arena.start_lifecycle_rounds(U64(1), terms());
    context("oracle.testnet", NearToken::from_yoctonear(1), START);
    arena.open_lifecycle_round(U64(1), U64(1), U64(START));
    // Round one is live.
    try_every_change(&mut arena, START);

    context(
        "oracle.testnet",
        NearToken::from_yoctonear(1),
        START + ROUND,
    );
    let tie = vec![
        observation(0, 110, START),
        observation(1, 110, START),
        observation(2, 102, START),
    ];
    assert_eq!(
        arena.submit_lifecycle_observations(U64(1), U64(1), tie),
        RoundOutcome::Overtime {
            next_candidates: vec![0, 1]
        }
    );
    // Overtime: the next round is open and still nothing can change.
    arena.open_lifecycle_round(U64(1), U64(2), U64(START + ROUND));
    try_every_change(&mut arena, START + ROUND);

    context(
        "oracle.testnet",
        NearToken::from_yoctonear(1),
        START + 2 * ROUND,
    );
    let fin = vec![
        observation(0, 96, START + ROUND),
        observation(1, 95, START + ROUND),
    ];
    assert_eq!(
        arena.submit_lifecycle_observations(U64(1), U64(2), fin),
        RoundOutcome::Winner { community: 0 }
    );
    // Even after a winner exists the frozen vaults cannot change.
    try_every_change(&mut arena, START + 2 * ROUND);
}

#[test]
fn the_whole_winning_vault_is_held_apart_from_losing_vault_settlement() {
    let mut arena = locked_arena();
    assert_eq!(
        arena.lifecycle_losing_vault(1, 0),
        Err(LifecycleError::WinnerNotResolved)
    );
    let hold = arena.lifecycle_hold_principal(1, 0).expect("hold");
    assert_eq!((hold.community, hold.amount), (0, 10));
    assert_eq!(hold.asset.representation, token(1));
    // The winning vault is never a settlement input; the losing ones are.
    assert_eq!(
        arena.lifecycle_losing_vault(1, 0),
        Err(LifecycleError::WinningVault)
    );
    assert_eq!(
        arena.lifecycle_losing_vault(1, 1).expect("loser").amount,
        10
    );
    assert_eq!(
        arena.lifecycle_losing_vault(1, 2).expect("loser").amount,
        10
    );
    let plan: Vec<PlannedEntitlement> = arena.settlement_plan(1).expect("plan");
    assert!(!plan.is_empty());
    assert!(plan.iter().all(|entry| entry.backing != token(1)));
    // The held amount cannot be re-recorded as a different winner or amount.
    assert_eq!(
        arena.lifecycle_hold_principal(1, 1),
        Err(LifecycleError::ConflictingWinner)
    );
    assert_eq!(
        arena.lifecycle_hold_principal(1, 0).expect("same").amount,
        10
    );
}

#[test]
fn held_principal_has_no_owner_worker_or_participant_exit() {
    let mut arena = locked_arena();
    context("owner.testnet", NearToken::from_yoctonear(1), 0);
    arena.add_agent(account("worker.testnet"));
    arena.lifecycle_hold_principal(1, 0).expect("hold");
    // The legacy liquid-balance withdrawal sees no balance for a lifecycle token.
    for caller in [
        "owner.testnet",
        "worker.testnet",
        "creator.testnet",
        "other.testnet",
    ] {
        context(caller, NearToken::from_yoctonear(1), 0);
        assert!(panics(|| {
            let _ = arena.withdraw_liquid(token(1), U128(1));
        }));
    }
    // Neither the hold nor the participant's recorded position moved.
    let hold = arena
        .lifecycle_battles
        .get(&1)
        .expect("battle")
        .principal_hold()
        .cloned();
    assert_eq!(hold.map(|h| (h.community, h.amount)), Some((0, 10)));
    assert_eq!(
        arena.lifecycle_position(1, 0, &account("creator.testnet")),
        10
    );
    // Closed to deposits as well: a transfer of the held token is returned.
    context("token1.testnet", NearToken::from_yoctonear(0), 0);
    let msg = r#"{"action":"lifecycle_deposit","battle_id":1,"community":0}"#.to_string();
    match arena.ft_on_transfer(account("creator.testnet"), U128(3), msg) {
        PromiseOrValue::Value(unused) => assert_eq!(unused, U128(3)),
        PromiseOrValue::Promise(_) => panic!("unexpected promise"),
    }
}

#[test]
fn unresolved_governance_does_not_block_losing_token_payouts() {
    let mut arena = locked_arena();
    arena.lifecycle_hold_principal(1, 0).expect("hold");
    // No governance decision exists or is consulted: the principal stays held
    // and settlement of the independently backed losing tokens proceeds.
    assert!(arena
        .lifecycle_battles
        .get(&1)
        .expect("battle")
        .principal_hold()
        .is_some());
    context("anyone.testnet", NearToken::from_near(1), 0);
    assert!(matches!(
        arena.settle_lifecycle_battle(U64(1), 15),
        PromiseOrValue::Promise(_)
    ));
    let progress = arena.get_settlement_progress(U64(1)).expect("progress");
    assert_eq!(progress.total, 2);
    assert_eq!(
        arena
            .lifecycle_battles
            .get(&1)
            .expect("battle")
            .principal_hold()
            .map(|h| h.amount),
        Some(10)
    );
}

fn terms() -> crate::rounds_api::ObservationTermsInput {
    crate::rounds_api::ObservationTermsInput {
        source: "source".into(),
        quote_currency: "USD".into(),
        eligible_pools: vec!["pool".into()],
        finality: "finalized".into(),
        price_decimals: 6,
        supply_decimals: 2,
        volume_decimals: 8,
        boundary_tolerance_ns: U64(0),
        max_gap_ns: U64(ROUND),
    }
}
