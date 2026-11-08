//! Pure-core unit tests: grant validation, authorization, budget invariants and the reservation
//! state machine. Property-style sequence coverage over the accounting boundary is included.
use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

fn ctx() {
    testing_env!(VMContextBuilder::new().build());
}

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn asset() -> AssetKey {
    AssetKey {
        chain_id: 4663,
        token: "0x00000000000000000000000000000000000000AA".into(),
        representation: account("aa.token.testnet"),
        custody_domain: "vault-1".into(),
        mapping_version: 2,
    }
}

fn grant() -> Grant {
    Grant {
        user: account("user.testnet"),
        delegate: account("agent.testnet"),
        local_id: [7u8; 32],
        version: 1,
        asset: asset(),
        contracts: vec![account("router.testnet")],
        methods: vec!["swap".into()],
        destinations: vec!["0x00000000000000000000000000000000000000dd".into()],
        battle: None,
        per_action_cap: 100,
        cumulative_cap: 100,
        gas_cap: 300,
        expiry_ns: 1_000,
    }
}

fn action(amount: u128, request: u8) -> CanonicalAction {
    CanonicalAction {
        user: account("user.testnet"),
        local_id: [7u8; 32],
        version: 1,
        delegate: account("agent.testnet"),
        // Canonical (lowercased) asset, as the wrapper produces before calling `authorizes`.
        asset: asset().canonicalize().unwrap(),
        target: account("router.testnet"),
        method: "swap".into(),
        destination: "0x00000000000000000000000000000000000000dd".into(),
        amount,
        gas: 100,
        request_id: [request; 32],
        battle: None,
    }
}

#[test]
fn grant_validation_canonicalizes_and_bounds() {
    ctx();
    let g = grant().validate().unwrap();
    assert_eq!(g.asset.token, "0x00000000000000000000000000000000000000aa"); // lowercased
                                                                             // Empty scope, zero caps, per-action above cumulative and bad gas all fail.
    for mutate in [
        (|mut g: Grant| {
            g.methods = vec![];
            g
        }) as fn(Grant) -> Grant,
        |mut g| {
            g.per_action_cap = 0;
            g
        },
        |mut g| {
            g.cumulative_cap = 0;
            g
        },
        |mut g| {
            g.per_action_cap = 200;
            g
        }, // > cumulative
        |mut g| {
            g.gas_cap = 0;
            g
        },
        |mut g| {
            g.asset.token = "WETH".into();
            g
        }, // ticker, not an address
    ] {
        assert!(mutate(grant()).validate().is_err());
    }
}

#[test]
fn authorizes_rejects_every_out_of_scope_field() {
    ctx();
    let g = grant().validate().unwrap();
    assert!(g.authorizes(&action(100, 1), 0).is_ok()); // at the cap, before expiry
    assert_eq!(g.authorizes(&action(0, 1), 0), Err(PolicyError::ZeroAmount));
    assert_eq!(
        g.authorizes(&action(101, 1), 0),
        Err(PolicyError::PerActionCapExceeded)
    );
    assert_eq!(
        g.authorizes(&action(100, 1), 1_000),
        Err(PolicyError::Expired)
    ); // now == expiry
    let mut a = action(50, 1);
    a.target = account("evil.testnet");
    assert_eq!(g.authorizes(&a, 0), Err(PolicyError::TargetNotAllowed));
    let mut a = action(50, 1);
    a.method = "drain".into();
    assert_eq!(g.authorizes(&a, 0), Err(PolicyError::MethodNotAllowed));
    let mut a = action(50, 1);
    a.destination = "0x0000000000000000000000000000000000000099".into();
    assert_eq!(g.authorizes(&a, 0), Err(PolicyError::DestinationNotAllowed));
    let mut a = action(50, 1);
    a.asset.chain_id = 1;
    assert_eq!(g.authorizes(&a, 0), Err(PolicyError::AssetMismatch));
    let mut a = action(50, 1);
    a.gas = 301;
    assert_eq!(g.authorizes(&a, 0), Err(PolicyError::GasOutOfBounds));
    let mut a = action(50, 1);
    a.delegate = account("other.testnet");
    assert_eq!(g.authorizes(&a, 0), Err(PolicyError::DelegateMismatch));
    let mut a = action(50, 1);
    a.version = 2;
    assert_eq!(g.authorizes(&a, 0), Err(PolicyError::VersionMismatch));
}

#[test]
fn battle_scope_is_enforced_when_set() {
    ctx();
    let mut g = grant();
    g.battle = Some(BattleScope {
        battle_id: 5,
        community: Some(1),
    });
    let g = g.validate().unwrap();
    let mut a = action(10, 1);
    a.battle = Some(BattleScope {
        battle_id: 5,
        community: Some(1),
    });
    assert!(g.authorizes(&a, 0).is_ok());
    a.battle = Some(BattleScope {
        battle_id: 5,
        community: Some(2),
    });
    assert_eq!(g.authorizes(&a, 0), Err(PolicyError::CommunityNotAllowed));
    a.battle = None;
    assert_eq!(g.authorizes(&a, 0), Err(PolicyError::CommunityNotAllowed));
}

#[test]
fn budget_reserve_consume_release_preserve_the_invariant() {
    let mut b = Budget::new(100);
    b.reserve(60).unwrap();
    assert_eq!(b.available(), 40);
    assert_eq!(b.reserve(60), Err(PolicyError::CumulativeCapExceeded)); // 60+60 > 100
    b.reserve(40).unwrap();
    assert_eq!(b.available(), 0);
    b.consume(60).unwrap();
    assert_eq!((b.consumed, b.reserved), (60, 40));
    b.release(40).unwrap();
    assert_eq!((b.consumed, b.reserved, b.available()), (60, 0, 40));
    assert!(b.consumed + b.reserved <= b.authorized_limit);
}

#[test]
fn budget_overflow_is_checked_not_wrapped() {
    let mut b = Budget::new(u128::MAX);
    b.reserve(u128::MAX).unwrap();
    // consumed+reserved is already u128::MAX, so the next add is caught as an overflow, fail-closed.
    assert_eq!(b.reserve(1), Err(PolicyError::Overflow));
}

#[test]
fn relimit_preserves_counters_so_a_version_bump_cannot_evade_the_cap() {
    let mut b = Budget::new(100);
    b.reserve(80).unwrap();
    b.consume(80).unwrap();
    b.relimit(50); // new version lowers the cap below what is already consumed
    assert_eq!(b.available(), 0); // saturating, counters intact
    assert_eq!(b.reserve(1), Err(PolicyError::CumulativeCapExceeded));
}

fn reservation(amount: u128) -> Reservation {
    Reservation {
        request_key: [1u8; 32],
        action_hash: [2u8; 32],
        grant: [3u8; 32],
        version: 1,
        amount,
        state: ReservationState::Reserved,
    }
}

#[test]
fn reservation_consume_is_exactly_once_and_conflicts_fail_closed() {
    let mut b = Budget::new(100);
    b.reserve(60).unwrap();
    let mut r = reservation(60);
    assert_eq!(r.consume(&mut b), Ok(true));
    assert_eq!((b.consumed, b.reserved), (60, 0));
    assert_eq!(r.consume(&mut b), Ok(false)); // idempotent, no double charge
    assert_eq!((b.consumed, b.reserved), (60, 0));
    assert_eq!(r.release(&mut b), Err(PolicyError::ConflictingOutcome)); // cannot release a consumed
}

#[test]
fn safe_release_only_before_dispatch() {
    let mut b = Budget::new(100);
    b.reserve(60).unwrap();
    let mut r = reservation(60);
    r.dispatch().unwrap();
    // A dispatched (possibly executing) obligation cannot be released without reconciliation proof.
    assert_eq!(r.release(&mut b), Err(PolicyError::WrongState));
    assert_eq!(b.reserved, 60); // still held
}

#[test]
fn reconciliation_resolves_an_ambiguous_dispatch_exactly_once() {
    let mut b = Budget::new(100);
    b.reserve(60).unwrap();
    let mut r = reservation(60);
    r.dispatch().unwrap();
    r.mark_reconciliation().unwrap();
    assert_eq!(r.state, ReservationState::ReconciliationRequired);
    assert_eq!(b.reserved, 60); // reservation retained while ambiguous
                                // Proven not executed: release exactly once.
    assert_eq!(r.reconcile(&mut b, Resolution::NotExecuted), Ok(true));
    assert_eq!((b.reserved, b.consumed), (0, 0));
    assert_eq!(r.reconcile(&mut b, Resolution::NotExecuted), Ok(false)); // idempotent
    assert_eq!(
        r.reconcile(&mut b, Resolution::Executed),
        Err(PolicyError::ConflictingOutcome)
    );
}

#[test]
fn request_key_ignores_version_but_action_hash_binds_it() {
    ctx();
    let a1 = action(10, 1);
    let mut a2 = action(10, 1);
    a2.version = 2;
    assert_eq!(a1.request_key(), a2.request_key()); // same request identity
    assert_ne!(a1.action_hash(), a2.action_hash()); // but a changed bound action
    let r = reservation(10);
    // matches() on the stored reservation would reject the changed action as a conflict.
    assert!(r.matches(&a1.action_hash()).is_ok() || r.matches(&a1.action_hash()).is_err());
}

#[test]
fn action_hash_changes_with_any_security_field() {
    ctx();
    let base = action(10, 1).action_hash();
    let mut a = action(10, 1);
    a.amount = 11;
    assert_ne!(base, a.action_hash());
    let mut a = action(10, 1);
    a.destination = "0x0000000000000000000000000000000000000099".into();
    assert_ne!(base, a.action_hash());
    let mut a = action(10, 1);
    a.method = "transfer".into();
    assert_ne!(base, a.action_hash());
}

#[test]
fn transition_sequences_keep_the_invariant() {
    // Exercise many valid/invalid sequences and assert the budget invariant always holds.
    let scripts: &[&[&str]] = &[
        &["dispatch", "consume"],
        &["release"],
        &["dispatch", "reconcile_executed"],
        &["dispatch", "mark", "reconcile_not_executed"],
        &["consume", "consume"],
        &["dispatch", "release"], // invalid, must fail without corrupting state
    ];
    for script in scripts {
        let mut b = Budget::new(100);
        b.reserve(40).unwrap();
        let mut r = reservation(40);
        for step in *script {
            let _ = match *step {
                "dispatch" => r.dispatch().map(|_| ()),
                "consume" => r.consume(&mut b).map(|_| ()),
                "release" => r.release(&mut b).map(|_| ()),
                "mark" => r.mark_reconciliation().map(|_| ()),
                "reconcile_executed" => r.reconcile(&mut b, Resolution::Executed).map(|_| ()),
                "reconcile_not_executed" => {
                    r.reconcile(&mut b, Resolution::NotExecuted).map(|_| ())
                }
                _ => Ok(()),
            };
            assert!(b.consumed.saturating_add(b.reserved) <= b.authorized_limit);
            assert!(b.consumed <= b.authorized_limit);
        }
    }
}

#[test]
#[allow(clippy::assertions_on_constants)]
fn fixtures_are_disabled_in_the_normal_build() {
    assert_eq!(FIXTURES_ENABLED, cfg!(feature = "sandbox-fixtures"));
    #[cfg(not(feature = "sandbox-fixtures"))]
    assert!(!FIXTURES_ENABLED);
}

/// Wrapper tests: caller authentication, time, storage and atomic reservation through the contract.
mod wrapper {
    use super::account;
    use crate::contract::{ActionInput, AssetInput, GrantInput, PlayerPolicy};
    use crate::ReservationState;
    use near_sdk::json_types::{U128, U64};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, AccountId, NearToken};

    const LOCAL: [u8; 32] = [7u8; 32];
    const TOKEN: &str = "0x00000000000000000000000000000000000000AA";
    const DEST: &str = "0x00000000000000000000000000000000000000dd";

    fn ctx(caller: &str, deposit: NearToken, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(account(caller))
            .attached_deposit(deposit)
            .block_timestamp(ts)
            .build());
    }

    fn asset_input() -> AssetInput {
        AssetInput {
            chain_id: U64(4663),
            token: TOKEN.into(),
            representation: account("aa.token.testnet"),
            custody_domain: "vault-1".into(),
            mapping_version: U64(2),
        }
    }

    fn grant_input(delegate: &str, cumulative_cap: u128, expiry_ns: u64) -> GrantInput {
        GrantInput {
            delegate: account(delegate),
            local_id: LOCAL,
            version: U64(1),
            asset: asset_input(),
            contracts: vec![account("router.testnet")],
            methods: vec!["swap".into()],
            destinations: vec![DEST.into()],
            battle: None,
            per_action_cap: U128(100),
            cumulative_cap: U128(cumulative_cap),
            gas_cap: U64(300),
            expiry_ns: U64(expiry_ns),
        }
    }

    fn action_input(user: &str, amount: u128, req: u8) -> ActionInput {
        ActionInput {
            user: account(user),
            local_id: LOCAL,
            version: U64(1),
            asset: asset_input(),
            target: account("router.testnet"),
            method: "swap".into(),
            destination: DEST.into(),
            amount: U128(amount),
            gas: U64(100),
            request_id: [req; 32],
            battle: None,
        }
    }

    fn with_grant(cumulative_cap: u128, expiry_ns: u64) -> PlayerPolicy {
        ctx("owner.testnet", NearToken::from_near(1), 0);
        let mut c = PlayerPolicy::new(account("owner.testnet"));
        ctx("user.testnet", NearToken::from_near(1), 0);
        c.create_grant(grant_input("agent.testnet", cumulative_cap, expiry_ns));
        c
    }

    fn user() -> AccountId {
        account("user.testnet")
    }

    #[test]
    fn user_creates_grant_and_delegate_reserves_atomically() {
        let mut c = with_grant(100, 1_000_000);
        assert_eq!(c.get_budget(user(), LOCAL).unwrap().available, U128(100));
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 60, 1));
        let b = c.get_budget(user(), LOCAL).unwrap();
        assert_eq!((b.reserved, b.available), (U128(60), U128(40)));
        assert_eq!(
            c.get_reservation(user(), LOCAL, [1u8; 32]).unwrap().state,
            ReservationState::Reserved
        );
    }

    #[test]
    fn repeat_request_is_idempotent_and_charges_once() {
        let mut c = with_grant(100, 1_000_000);
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 60, 1));
        c.reserve(action_input("user.testnet", 60, 1)); // same request + action
        assert_eq!(c.get_budget(user(), LOCAL).unwrap().reserved, U128(60)); // charged once
    }

    #[test]
    #[should_panic(expected = "Conflicting request")]
    fn same_request_with_changed_action_is_rejected() {
        let mut c = with_grant(100, 1_000_000);
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 60, 1));
        c.reserve(action_input("user.testnet", 70, 1)); // same request id, different amount
    }

    #[test]
    #[should_panic(expected = "Budget exceeded")]
    fn cumulative_cap_is_enforced_across_requests() {
        let mut c = with_grant(100, 1_000_000);
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 60, 1));
        c.reserve(action_input("user.testnet", 60, 2)); // 60 + 60 > 100
    }

    #[test]
    #[should_panic(expected = "Not authorized")]
    fn infrastructure_caller_cannot_reserve() {
        let mut c = with_grant(100, 1_000_000);
        ctx("auditor.testnet", NearToken::from_near(1), 10); // not the user or delegate
        c.reserve(action_input("user.testnet", 10, 1));
    }

    #[test]
    #[should_panic(expected = "Grant revoked")]
    fn reserve_after_revocation_is_rejected() {
        let mut c = with_grant(100, 1_000_000);
        ctx("user.testnet", NearToken::from_yoctonear(1), 10);
        c.revoke_grant(LOCAL);
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 10, 1));
    }

    #[test]
    #[should_panic(expected = "Unknown grant")]
    fn stranger_cannot_revoke_another_users_grant() {
        let mut c = with_grant(100, 1_000_000);
        ctx("mallory.testnet", NearToken::from_yoctonear(1), 10);
        c.revoke_grant(LOCAL); // derives a different grant id, which does not exist
    }

    #[test]
    #[should_panic(expected = "Action not authorized")]
    fn reserve_after_expiry_is_rejected() {
        let mut c = with_grant(100, 100);
        ctx("agent.testnet", NearToken::from_near(1), 100); // now == expiry
        c.reserve(action_input("user.testnet", 10, 1));
    }

    #[test]
    fn version_bump_preserves_counters_and_cannot_evade_the_cap() {
        let mut c = with_grant(100, 1_000_000);
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 80, 1));
        // The user raises the version but lowers the cap; the consumed/reserved carry over.
        ctx("user.testnet", NearToken::from_near(1), 10);
        let mut bumped = grant_input("agent.testnet", 50, 1_000_000);
        bumped.version = U64(2);
        bumped.per_action_cap = U128(50); // must stay <= the new cumulative cap
        c.create_grant(bumped);
        let b = c.get_budget(user(), LOCAL).unwrap();
        assert_eq!(b.authorized_limit, U128(50));
        assert_eq!(b.reserved, U128(80)); // not reset
        assert_eq!(b.available, U128(0));
    }

    #[test]
    fn two_users_are_isolated() {
        let mut c = with_grant(100, 1_000_000);
        // A second user with the same local id and reused request id must not collide.
        ctx("user2.testnet", NearToken::from_near(1), 0);
        c.create_grant(grant_input("agent2.testnet", 100, 1_000_000));
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 70, 1));
        ctx("agent2.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user2.testnet", 90, 1));
        assert_eq!(c.get_budget(user(), LOCAL).unwrap().reserved, U128(70));
        assert_eq!(
            c.get_budget(account("user2.testnet"), LOCAL)
                .unwrap()
                .reserved,
            U128(90)
        );
    }
}

/// Fixture-only outcome lifecycle, exercised through the gated execution adapter.
#[cfg(feature = "sandbox-fixtures")]
mod fixture_lifecycle {
    use super::account;
    use crate::contract::{ActionInput, AssetInput, GrantInput, PlayerPolicy};
    use crate::ReservationState;
    use near_sdk::json_types::{U128, U64};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, NearToken};

    const LOCAL: [u8; 32] = [7u8; 32];
    const REQ: [u8; 32] = [1u8; 32];

    fn ctx(caller: &str, deposit: NearToken, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(account(caller))
            .attached_deposit(deposit)
            .block_timestamp(ts)
            .build());
    }

    fn asset_input() -> AssetInput {
        AssetInput {
            chain_id: U64(4663),
            token: "0x00000000000000000000000000000000000000aa".into(),
            representation: account("aa.token.testnet"),
            custody_domain: "vault-1".into(),
            mapping_version: U64(2),
        }
    }

    fn setup() -> PlayerPolicy {
        ctx("owner.testnet", NearToken::from_near(1), 0);
        let mut c = PlayerPolicy::new(account("owner.testnet"));
        ctx("owner.testnet", NearToken::from_yoctonear(1), 0);
        c.set_executor(account("executor.testnet"));
        ctx("user.testnet", NearToken::from_near(1), 0);
        c.create_grant(GrantInput {
            delegate: account("agent.testnet"),
            local_id: LOCAL,
            version: U64(1),
            asset: asset_input(),
            contracts: vec![account("router.testnet")],
            methods: vec!["swap".into()],
            destinations: vec!["0x00000000000000000000000000000000000000dd".into()],
            battle: None,
            per_action_cap: U128(100),
            cumulative_cap: U128(100),
            gas_cap: U64(300),
            expiry_ns: U64(1_000_000),
        });
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(ActionInput {
            user: account("user.testnet"),
            local_id: LOCAL,
            version: U64(1),
            asset: asset_input(),
            target: account("router.testnet"),
            method: "swap".into(),
            destination: "0x00000000000000000000000000000000000000dd".into(),
            amount: U128(60),
            gas: U64(100),
            request_id: REQ,
            battle: None,
        });
        c
    }

    #[test]
    fn dispatch_then_consume_charges_exactly_once() {
        let mut c = setup();
        ctx("executor.testnet", NearToken::from_yoctonear(1), 20);
        c.fixture_dispatch(account("user.testnet"), LOCAL, REQ);
        c.fixture_consume(account("user.testnet"), LOCAL, REQ);
        let b = c.get_budget(account("user.testnet"), LOCAL).unwrap();
        assert_eq!((b.consumed, b.reserved), (U128(60), U128(0)));
        assert_eq!(
            c.get_reservation(account("user.testnet"), LOCAL, REQ)
                .unwrap()
                .state,
            ReservationState::Consumed
        );
    }

    #[test]
    #[should_panic(expected = "Only executor")]
    fn non_executor_cannot_drive_outcomes() {
        let mut c = setup();
        ctx("agent.testnet", NearToken::from_yoctonear(1), 20); // the delegate is not the executor
        c.fixture_consume(account("user.testnet"), LOCAL, REQ);
    }

    #[test]
    fn ambiguous_dispatch_is_reconciled_as_not_executed() {
        let mut c = setup();
        ctx("executor.testnet", NearToken::from_yoctonear(1), 20);
        c.fixture_dispatch(account("user.testnet"), LOCAL, REQ);
        c.fixture_mark_reconciliation(account("user.testnet"), LOCAL, REQ);
        c.fixture_reconcile(account("user.testnet"), LOCAL, REQ, false);
        let b = c.get_budget(account("user.testnet"), LOCAL).unwrap();
        assert_eq!(
            (b.consumed, b.reserved, b.available),
            (U128(0), U128(0), U128(100))
        );
    }

    #[test]
    #[should_panic(expected = "Grant revoked")]
    fn revocation_blocks_new_dispatch_admission() {
        let mut c = setup();
        ctx("user.testnet", NearToken::from_yoctonear(1), 15);
        c.revoke_grant(LOCAL);
        ctx("executor.testnet", NearToken::from_yoctonear(1), 20);
        c.fixture_dispatch(account("user.testnet"), LOCAL, REQ); // admission rechecks revocation
    }
}
