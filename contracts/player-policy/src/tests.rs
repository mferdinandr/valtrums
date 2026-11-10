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
    b.consume(30).unwrap();
    let before = b;
    assert_eq!(b.relimit(79), Err(PolicyError::CumulativeCapExceeded));
    assert_eq!(b, before); // rejected replacement changes neither counters nor limit
    b.relimit(80).unwrap(); // exact outstanding use is a valid lower limit
    assert_eq!((b.consumed, b.reserved, b.available()), (30, 50, 0));
    b.relimit(120).unwrap();
    assert_eq!((b.consumed, b.reserved, b.available()), (30, 50, 40));
    assert!(b.consumed + b.reserved <= b.authorized_limit);
}

#[test]
fn relimit_rejects_consumed_obligations_and_overflow_without_mutation() {
    let mut b = Budget::new(100);
    b.reserve(80).unwrap();
    b.consume(80).unwrap();
    let before = b;
    assert_eq!(b.relimit(50), Err(PolicyError::CumulativeCapExceeded));
    assert_eq!(b, before);
    let mut corrupt = Budget {
        authorized_limit: u128::MAX,
        consumed: u128::MAX,
        reserved: 1,
    };
    let before = corrupt;
    assert_eq!(corrupt.relimit(u128::MAX), Err(PolicyError::Overflow));
    assert_eq!(corrupt, before);
}

fn reservation(amount: u128) -> Reservation {
    Reservation {
        request_key: [1u8; 32],
        action_hash: [2u8; 32],
        grant: [3u8; 32],
        version: 1,
        amount,
        state: ReservationState::Reserved,
        battle_id: Some(5),
        expires_ns: 1_000,
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
    r.dispatch(0).unwrap();
    // A dispatched (possibly executing) obligation cannot be released without reconciliation proof.
    assert_eq!(r.release(&mut b), Err(PolicyError::WrongState));
    assert_eq!(b.reserved, 60); // still held
}

#[test]
fn reconciliation_resolves_an_ambiguous_dispatch_exactly_once() {
    let mut b = Budget::new(100);
    b.reserve(60).unwrap();
    let mut r = reservation(60);
    r.dispatch(0).unwrap();
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
fn delegate_must_differ_from_the_user() {
    ctx();
    let mut g = grant();
    g.delegate = g.user.clone();
    assert_eq!(g.validate().err(), Some(PolicyError::DelegateIsUser));
}

#[test]
fn expiry_releases_only_an_undispatched_reservation_once_due() {
    let mut b = Budget::new(100);
    b.reserve(60).unwrap();
    let mut r = reservation(60); // expires at 1_000
    assert_eq!(r.expire(&mut b, 999), Err(PolicyError::NotExpired));
    assert_eq!(b.reserved, 60);
    assert_eq!(r.expire(&mut b, 1_000), Ok(true));
    assert_eq!((b.reserved, b.consumed), (0, 0));
    assert_eq!(r.expire(&mut b, 2_000), Ok(false)); // idempotent, no double release
    assert_eq!(b.reserved, 0);
}

#[test]
fn expiry_never_releases_a_dispatched_or_ambiguous_obligation() {
    let mut b = Budget::new(100);
    b.reserve(60).unwrap();
    let mut r = reservation(60);
    r.dispatch(0).unwrap();
    assert_eq!(r.expire(&mut b, u64::MAX), Err(PolicyError::WrongState));
    r.mark_reconciliation().unwrap();
    assert_eq!(r.expire(&mut b, u64::MAX), Err(PolicyError::WrongState));
    assert_eq!(r.release(&mut b), Err(PolicyError::WrongState));
    assert_eq!(b.reserved, 60); // still held until explicit evidence
    r.reconcile(&mut b, Resolution::Executed).unwrap();
    assert_eq!(
        r.expire(&mut b, u64::MAX),
        Err(PolicyError::ConflictingOutcome)
    );
}

#[test]
fn an_expired_reservation_cannot_be_admitted_for_execution() {
    let mut r = reservation(60);
    assert_eq!(r.dispatch(1_000), Err(PolicyError::ReservationExpired));
    assert_eq!(r.state, ReservationState::Reserved);
    assert_eq!(r.dispatch(999), Ok(true));
    assert_eq!(r.dispatch(5_000), Ok(false)); // a repeat is not a fresh admission
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
    let mut r = r;
    r.action_hash = a1.action_hash();
    assert_eq!(r.matches(&a1.action_hash()), Ok(()));
    assert_eq!(r.matches(&a2.action_hash()), Err(PolicyError::Conflict));
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
                "dispatch" => r.dispatch(0).map(|_| ()),
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
        let mut c = PlayerPolicy::new(account("owner.testnet"), account("registry.testnet"));
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
        // The user lowers the cap to exactly existing obligations; counters carry over.
        ctx("user.testnet", NearToken::from_near(1), 10);
        let mut bumped = grant_input("agent.testnet", 80, 1_000_000);
        bumped.version = U64(2);
        bumped.per_action_cap = U128(80);
        c.create_grant(bumped);
        let b = c.get_budget(user(), LOCAL).unwrap();
        assert_eq!(b.authorized_limit, U128(80));
        assert_eq!(b.reserved, U128(80)); // not reset
        assert_eq!(b.available, U128(0));
    }

    #[test]
    #[should_panic(expected = "Grant cap below existing obligations")]
    fn version_bump_cannot_lower_cap_below_reserved_amount() {
        let mut c = with_grant(100, 1_000_000);
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 80, 1));
        ctx("user.testnet", NearToken::from_near(1), 10);
        let mut bumped = grant_input("agent.testnet", 50, 1_000_000);
        bumped.version = U64(2);
        bumped.per_action_cap = U128(50);
        c.create_grant(bumped);
    }

    #[test]
    #[should_panic(expected = "Grant asset cannot change")]
    fn version_bump_cannot_relabel_reserved_units_as_another_asset() {
        let mut c = with_grant(100, 1_000_000);
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 80, 1));
        ctx("user.testnet", NearToken::from_near(1), 10);
        let mut bumped = grant_input("agent.testnet", 100, 1_000_000);
        bumped.version = U64(2);
        bumped.asset.token = "0x00000000000000000000000000000000000000bb".into();
        c.create_grant(bumped);
    }

    #[test]
    fn canonical_inputs_reject_unknown_fields_at_every_level() {
        use near_sdk::serde_json::{from_value, json, to_value};
        let valid = to_value(action_input("user.testnet", 10, 1)).unwrap();
        assert!(from_value::<ActionInput>(valid.clone()).is_ok());
        let mut unknown_action = valid.clone();
        unknown_action["calldata"] = json!("uncommitted payload");
        assert!(from_value::<ActionInput>(unknown_action).is_err());
        let mut unknown_asset = valid.clone();
        unknown_asset["asset"]["alias"] = json!("uncommitted asset");
        assert!(from_value::<ActionInput>(unknown_asset).is_err());
        let mut unknown_battle = valid;
        unknown_battle["battle"] = json!({"battle_id": "1", "community": 0, "override": true});
        assert!(from_value::<ActionInput>(unknown_battle).is_err());
        let mut unknown_grant = to_value(grant_input("agent.testnet", 100, 1_000_000)).unwrap();
        unknown_grant["unlimited"] = json!(true);
        assert!(from_value::<GrantInput>(unknown_grant).is_err());
    }

    #[test]
    fn grant_reservation_and_revocation_emit_nep297_data_arrays() {
        use near_sdk::serde_json::{from_str, Value};
        use near_sdk::test_utils::get_logs;
        fn assert_event(expected: &str) {
            let logs = get_logs();
            let event: Value =
                from_str(logs.last().unwrap().strip_prefix("EVENT_JSON:").unwrap()).unwrap();
            assert_eq!(event["standard"], "valtrum_player_policy");
            assert_eq!(event["version"], "1.0.0");
            assert_eq!(event["event"], expected);
            let data = event["data"].as_array().unwrap();
            assert_eq!(data.len(), 1);
            assert_eq!(data[0]["user"], "user.testnet");
        }
        let mut c = with_grant(100, 1_000_000);
        assert_event("grant_created");
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 10, 1));
        assert_event("budget_reserved");
        ctx("user.testnet", NearToken::from_yoctonear(1), 10);
        c.revoke_grant(LOCAL);
        assert_event("grant_revoked");
    }

    fn expect_panic<F: FnOnce()>(f: F) -> String {
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
            .expect_err("expected a panic");
        err.downcast_ref::<String>()
            .cloned()
            .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default()
    }

    const REQ: [u8; 32] = [1u8; 32];

    fn reserved_state(c: &PlayerPolicy) -> ReservationState {
        c.get_reservation(user(), LOCAL, REQ).unwrap().state
    }

    #[test]
    #[should_panic(expected = "Delegate must differ from user")]
    fn user_cannot_name_themselves_as_delegate() {
        ctx("owner.testnet", NearToken::from_near(1), 0);
        let mut c = PlayerPolicy::new(account("owner.testnet"), account("registry.testnet"));
        ctx("user.testnet", NearToken::from_near(1), 0);
        c.create_grant(grant_input("user.testnet", 100, 1_000_000));
    }

    #[test]
    fn revoked_grant_stays_revoked_and_a_new_local_id_continues() {
        let mut c = with_grant(100, 1_000_000);
        ctx("user.testnet", NearToken::from_yoctonear(1), 10);
        c.revoke_grant(LOCAL);
        ctx("user.testnet", NearToken::from_near(1), 11);
        let mut bumped = grant_input("agent.testnet", 100, 1_000_000);
        bumped.version = U64(2);
        let msg = expect_panic(|| c.create_grant(bumped));
        assert!(msg.contains("Grant revoked"), "{msg}");
        let view = c.get_grant(user(), LOCAL).unwrap();
        assert!(view.revoked);
        assert_eq!(view.version, U64(1));
        // A reservation is still refused on the old id.
        ctx("agent.testnet", NearToken::from_near(1), 12);
        let msg = expect_panic(|| c.reserve(action_input("user.testnet", 10, 1)));
        assert!(msg.contains("Grant revoked"), "{msg}");
        // A new local id is a separate grant with its own budget.
        ctx("user.testnet", NearToken::from_near(1), 13);
        let mut fresh = grant_input("agent.testnet", 100, 1_000_000);
        fresh.local_id = [8u8; 32];
        c.create_grant(fresh);
        assert!(!c.get_grant(user(), [8u8; 32]).unwrap().revoked);
        ctx("agent.testnet", NearToken::from_near(1), 14);
        let mut a = action_input("user.testnet", 10, 1);
        a.local_id = [8u8; 32];
        c.reserve(a);
        assert_eq!(c.get_budget(user(), [8u8; 32]).unwrap().reserved, U128(10));
    }

    #[test]
    fn asset_identity_is_immutable_per_grant_for_every_field() {
        let mut c = with_grant(100, 1_000_000);
        for field in 0..5 {
            ctx("user.testnet", NearToken::from_near(1), 10);
            let mut changed = grant_input("agent.testnet", 100, 1_000_000);
            changed.version = U64(2);
            match field {
                0 => changed.asset.chain_id = U64(1),
                1 => changed.asset.token = "0x00000000000000000000000000000000000000bb".into(),
                2 => changed.asset.representation = account("other.token.testnet"),
                3 => changed.asset.custody_domain = "vault-2".into(),
                _ => changed.asset.mapping_version = U64(3),
            }
            let msg = expect_panic(|| c.create_grant(changed));
            assert!(
                msg.contains("Grant asset cannot change"),
                "field {field}: {msg}"
            );
            assert_eq!(c.get_grant(user(), LOCAL).unwrap().version, U64(1));
        }
    }

    #[test]
    fn delegate_cancels_an_undispatched_reservation_and_budget_returns() {
        let mut c = with_grant(100, 1_000_000);
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 60, 1));
        ctx("agent.testnet", NearToken::from_yoctonear(1), 11);
        c.cancel_reservation(user(), LOCAL, REQ);
        assert_eq!(reserved_state(&c), ReservationState::Released);
        let b = c.get_budget(user(), LOCAL).unwrap();
        assert_eq!((b.reserved, b.available), (U128(0), U128(100)));
        c.cancel_reservation(user(), LOCAL, REQ); // idempotent, no double release
        assert_eq!(c.get_budget(user(), LOCAL).unwrap().available, U128(100));
    }

    #[test]
    fn user_cancels_even_after_revocation_but_revocation_alone_releases_nothing() {
        let mut c = with_grant(100, 1_000_000);
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 60, 1));
        ctx("user.testnet", NearToken::from_yoctonear(1), 11);
        c.revoke_grant(LOCAL);
        assert_eq!(reserved_state(&c), ReservationState::Reserved);
        assert_eq!(c.get_budget(user(), LOCAL).unwrap().reserved, U128(60));
        c.cancel_reservation(user(), LOCAL, REQ);
        assert_eq!(c.get_budget(user(), LOCAL).unwrap().reserved, U128(0));
    }

    #[test]
    fn infrastructure_and_owner_cannot_cancel_and_one_yocto_is_required() {
        let mut c = with_grant(100, 1_000_000);
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 60, 1));
        for caller in ["auditor.testnet", "owner.testnet", "mallory.testnet"] {
            ctx(caller, NearToken::from_yoctonear(1), 11);
            let msg = expect_panic(|| c.cancel_reservation(user(), LOCAL, REQ));
            assert!(msg.contains("Not authorized"), "{caller}: {msg}");
        }
        for deposit in [NearToken::from_yoctonear(0), NearToken::from_yoctonear(2)] {
            ctx("agent.testnet", deposit, 11);
            expect_panic(|| c.cancel_reservation(user(), LOCAL, REQ));
        }
        assert_eq!(reserved_state(&c), ReservationState::Reserved);
        assert_eq!(c.get_budget(user(), LOCAL).unwrap().reserved, U128(60));
    }

    #[test]
    fn a_released_request_id_cannot_be_reserved_again() {
        let mut c = with_grant(100, 1_000_000);
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 60, 1));
        ctx("agent.testnet", NearToken::from_yoctonear(1), 11);
        c.cancel_reservation(user(), LOCAL, REQ);
        ctx("agent.testnet", NearToken::from_near(1), 12);
        let msg = expect_panic(|| c.reserve(action_input("user.testnet", 60, 1)));
        assert!(msg.contains("Reservation released"), "{msg}");
        c.reserve(action_input("user.testnet", 60, 2)); // a new request id works
        assert_eq!(c.get_budget(user(), LOCAL).unwrap().reserved, U128(60));
    }

    #[test]
    fn reservations_expire_with_the_documented_default_and_release_permissionlessly() {
        use crate::contract::DEFAULT_RESERVATION_TTL_NS;
        let mut c = with_grant(100, u64::MAX / 2);
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 60, 1));
        let expires = 10 + DEFAULT_RESERVATION_TTL_NS;
        assert_eq!(
            c.get_reservation(user(), LOCAL, REQ).unwrap().expires_ns,
            U64(expires)
        );
        ctx("auditor.testnet", NearToken::from_yoctonear(1), expires - 1);
        let early = expect_panic(|| c.release_expired(user(), LOCAL, REQ));
        assert!(early.contains("cannot be released"), "{early}");
        assert_eq!(c.get_budget(user(), LOCAL).unwrap().reserved, U128(60));
        ctx("auditor.testnet", NearToken::from_yoctonear(1), expires);
        c.release_expired(user(), LOCAL, REQ);
        assert_eq!(reserved_state(&c), ReservationState::Released);
        assert_eq!(c.get_budget(user(), LOCAL).unwrap().available, U128(100));
        c.release_expired(user(), LOCAL, REQ); // idempotent
        assert_eq!(c.get_budget(user(), LOCAL).unwrap().available, U128(100));
    }

    #[test]
    fn release_expired_requires_exactly_one_yocto() {
        let mut c = with_grant(100, u64::MAX / 2);
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 60, 1));
        ctx(
            "auditor.testnet",
            NearToken::from_yoctonear(0),
            u64::MAX / 4,
        );
        expect_panic(|| c.release_expired(user(), LOCAL, REQ));
        assert_eq!(c.get_budget(user(), LOCAL).unwrap().reserved, U128(60));
    }

    #[test]
    fn repeating_an_expired_unreleased_reservation_fails_closed() {
        let mut c = with_grant(100, u64::MAX / 2);
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 60, 1));
        ctx("agent.testnet", NearToken::from_near(1), u64::MAX / 4);
        let msg = expect_panic(|| c.reserve(action_input("user.testnet", 60, 1)));
        assert!(msg.contains("Reservation expired"), "{msg}");
    }

    #[test]
    fn owner_configures_the_ttl_within_bounds_for_new_reservations_only() {
        use crate::contract::{MAX_RESERVATION_TTL_NS, MIN_RESERVATION_TTL_NS};
        let mut c = with_grant(100, u64::MAX / 2);
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action_input("user.testnet", 10, 1));
        let first = c.get_reservation(user(), LOCAL, REQ).unwrap().expires_ns;
        for caller in ["user.testnet", "agent.testnet", "auditor.testnet"] {
            ctx(caller, NearToken::from_yoctonear(1), 10);
            let msg = expect_panic(|| c.set_reservation_ttl(U64(MIN_RESERVATION_TTL_NS)));
            assert!(msg.contains("Only owner"), "{caller}");
        }
        ctx("owner.testnet", NearToken::from_yoctonear(1), 10);
        for bad in [MIN_RESERVATION_TTL_NS - 1, MAX_RESERVATION_TTL_NS + 1, 0] {
            assert!(expect_panic(|| c.set_reservation_ttl(U64(bad))).contains("out of bounds"));
        }
        c.set_reservation_ttl(U64(MIN_RESERVATION_TTL_NS));
        ctx("agent.testnet", NearToken::from_near(1), 20);
        c.reserve(action_input("user.testnet", 10, 2));
        let second = c
            .get_reservation(user(), LOCAL, [2u8; 32])
            .unwrap()
            .expires_ns;
        assert_eq!(second, U64(20 + MIN_RESERVATION_TTL_NS));
        assert_eq!(
            c.get_reservation(user(), LOCAL, REQ).unwrap().expires_ns,
            first
        );
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

/// Production obligation lifecycle: dispatch, reconciliation flag and consumption by finalized
/// receipt evidence. The registry answer is delivered by calling the callback directly, exactly as
/// the receipt of the registry call would; amounts are synthetic and nothing here moves funds.
mod lifecycle {
    use super::account;
    use crate::contract::{
        ActionInput, AssetInput, BattleInput, GrantInput, PlayerPolicy, CONFIRM_STORAGE_DEPOSIT,
    };
    use crate::{ReceiptClaim, ReceiptRef, ReservationState};
    use near_sdk::json_types::{U128, U64};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, AccountId, NearToken, PromiseError};

    const LOCAL: [u8; 32] = [7u8; 32];
    const REQ: [u8; 32] = [1u8; 32];
    const BATTLE: u64 = 5;

    fn ctx(caller: &str, deposit: NearToken, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(account(caller))
            .attached_deposit(deposit)
            .block_timestamp(ts)
            .build());
    }

    fn one() -> NearToken {
        NearToken::from_yoctonear(1)
    }

    fn user() -> AccountId {
        account("user.testnet")
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

    fn grant_input(version: u64, delegate: &str, expiry_ns: u64) -> GrantInput {
        GrantInput {
            delegate: account(delegate),
            local_id: LOCAL,
            version: U64(version),
            asset: asset_input(),
            contracts: vec![account("router.testnet")],
            methods: vec!["swap".into()],
            destinations: vec!["0x00000000000000000000000000000000000000dd".into()],
            battle: None,
            per_action_cap: U128(100),
            cumulative_cap: U128(100),
            gas_cap: U64(300),
            expiry_ns: U64(expiry_ns),
        }
    }

    fn action(amount: u128, req: u8, battle: Option<u64>) -> ActionInput {
        ActionInput {
            user: user(),
            local_id: LOCAL,
            version: U64(1),
            asset: asset_input(),
            target: account("router.testnet"),
            method: "swap".into(),
            destination: "0x00000000000000000000000000000000000000dd".into(),
            amount: U128(amount),
            gas: U64(100),
            request_id: [req; 32],
            battle: battle.map(|battle_id| BattleInput {
                battle_id: U64(battle_id),
                community: None,
            }),
        }
    }

    fn setup_with_expiry(expiry_ns: u64) -> PlayerPolicy {
        ctx("owner.testnet", NearToken::from_near(1), 0);
        let mut c = PlayerPolicy::new(account("owner.testnet"), account("registry.testnet"));
        ctx("user.testnet", NearToken::from_near(1), 0);
        c.create_grant(grant_input(1, "agent.testnet", expiry_ns));
        ctx("agent.testnet", NearToken::from_near(1), 10);
        c.reserve(action(60, 1, Some(BATTLE)));
        c
    }

    fn setup() -> PlayerPolicy {
        setup_with_expiry(1_000_000)
    }

    fn dispatch(c: &mut PlayerPolicy) {
        ctx("agent.testnet", one(), 20);
        c.dispatch(user(), LOCAL, REQ);
    }

    fn receipt(n: u8) -> ReceiptRef {
        ReceiptRef {
            transaction_hash: [n; 32],
            log_index: 0,
        }
    }

    fn claim(amount: u128) -> ReceiptClaim {
        ReceiptClaim {
            representation: account("aa.token.testnet"),
            token_address: "0x00000000000000000000000000000000000000AA".into(),
            custody_domain: "vault-1".into(),
            mapping_version: U64(2),
            beneficiary: user(),
            refund_address: [0xbe; 20],
            battle_id: U64(BATTLE),
            actual_received: U128(amount),
            block_number: U64(3),
            block_hash: [1; 32],
            finalized_head_number: U64(4),
            finalized_head_hash: [2; 32],
            evidence_hash: [3; 32],
        }
    }

    /// Deliver the registry's answer to the callback, as the contract itself.
    fn answer(
        c: &mut PlayerPolicy,
        req: u8,
        r: ReceiptRef,
        claim: Result<Option<ReceiptClaim>, PromiseError>,
    ) -> bool {
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("policy.testnet"))
            .predecessor_account_id(account("policy.testnet"))
            .attached_deposit(CONFIRM_STORAGE_DEPOSIT)
            .block_timestamp(30)
            .build());
        c.on_receipt_evidence(
            account("stranger.testnet"),
            user(),
            LOCAL,
            [req; 32],
            r,
            claim,
        )
    }

    type Mutation = (&'static str, Box<dyn Fn(&mut ReceiptClaim)>);

    fn state(c: &PlayerPolicy, req: u8) -> ReservationState {
        c.get_reservation(user(), LOCAL, [req; 32]).unwrap().state
    }

    fn budget(c: &PlayerPolicy) -> (U128, U128, U128) {
        let b = c.get_budget(user(), LOCAL).unwrap();
        (b.consumed, b.reserved, b.available)
    }

    #[test]
    fn dispatch_then_matching_receipt_consumes_exactly_once() {
        let mut c = setup();
        dispatch(&mut c);
        assert_eq!(state(&c, 1), ReservationState::Dispatched);
        // Anyone may submit the evidence; the registry claim is the only authority.
        ctx("stranger.testnet", CONFIRM_STORAGE_DEPOSIT, 25);
        let _ = c.confirm_with_receipt(user(), LOCAL, REQ, receipt(9));
        assert!(answer(&mut c, 1, receipt(9), Ok(Some(claim(60)))));
        assert_eq!(budget(&c), (U128(60), U128(0), U128(40)));
        assert_eq!(state(&c, 1), ReservationState::Consumed);
        assert!(c.is_receipt_used(receipt(9)));
        // Repeats and a second receipt neither double charge nor change the outcome.
        assert!(!answer(&mut c, 1, receipt(9), Ok(Some(claim(60)))));
        assert!(!answer(&mut c, 1, receipt(8), Ok(Some(claim(60)))));
        assert_eq!(budget(&c), (U128(60), U128(0), U128(40)));
    }

    #[test]
    #[should_panic(expected = "Not an in-flight obligation")]
    fn evidence_cannot_consume_an_undispatched_reservation() {
        let mut c = setup();
        ctx("stranger.testnet", CONFIRM_STORAGE_DEPOSIT, 25);
        let _ = c.confirm_with_receipt(user(), LOCAL, REQ, receipt(9));
    }

    #[test]
    fn the_callback_ignores_an_undispatched_reservation_too() {
        let mut c = setup();
        assert!(!answer(&mut c, 1, receipt(9), Ok(Some(claim(60)))));
        assert_eq!(budget(&c), (U128(0), U128(60), U128(40)));
    }

    #[test]
    #[should_panic(expected = "Insufficient storage deposit")]
    fn confirmation_requires_the_storage_deposit() {
        let mut c = setup();
        dispatch(&mut c);
        ctx("stranger.testnet", one(), 25);
        let _ = c.confirm_with_receipt(user(), LOCAL, REQ, receipt(9));
    }

    #[test]
    #[should_panic(expected = "Receipt already used")]
    fn a_used_receipt_is_rejected_before_calling_the_registry() {
        let mut c = setup();
        ctx("agent.testnet", NearToken::from_near(1), 11);
        c.reserve(action(40, 2, Some(BATTLE)));
        dispatch(&mut c);
        assert!(answer(&mut c, 1, receipt(9), Ok(Some(claim(60)))));
        ctx("agent.testnet", one(), 21);
        c.dispatch(user(), LOCAL, [2; 32]);
        ctx("stranger.testnet", CONFIRM_STORAGE_DEPOSIT, 25);
        let _ = c.confirm_with_receipt(user(), LOCAL, [2; 32], receipt(9));
    }

    #[test]
    fn evidence_that_does_not_bind_exactly_never_consumes() {
        let mutations: Vec<Mutation> = vec![
            (
                "representation",
                Box::new(|c| c.representation = account("x.testnet")),
            ),
            (
                "token",
                Box::new(|c| c.token_address = "0x00000000000000000000000000000000000000ab".into()),
            ),
            ("custody", Box::new(|c| c.custody_domain = "vault-2".into())),
            ("mapping", Box::new(|c| c.mapping_version = U64(3))),
            (
                "beneficiary",
                Box::new(|c| c.beneficiary = account("other.testnet")),
            ),
            ("battle", Box::new(|c| c.battle_id = U64(6))),
            ("less", Box::new(|c| c.actual_received = U128(59))),
            ("more", Box::new(|c| c.actual_received = U128(61))),
            ("refund", Box::new(|c| c.refund_address = [0; 20])),
            ("block hash", Box::new(|c| c.block_hash = [0; 32])),
            ("head hash", Box::new(|c| c.finalized_head_hash = [0; 32])),
            ("evidence", Box::new(|c| c.evidence_hash = [0; 32])),
            ("ahead of head", Box::new(|c| c.block_number = U64(5))),
            (
                "inconsistent head",
                Box::new(|c| {
                    c.block_number = U64(4);
                    c.block_hash = [9; 32];
                }),
            ),
        ];
        let mut c = setup();
        dispatch(&mut c);
        for (name, mutate) in mutations {
            let mut wrong = claim(60);
            mutate(&mut wrong);
            assert!(!answer(&mut c, 1, receipt(9), Ok(Some(wrong))), "{name}");
            assert_eq!(budget(&c), (U128(0), U128(60), U128(40)), "{name}");
            assert_eq!(state(&c, 1), ReservationState::Dispatched, "{name}");
            assert!(!c.is_receipt_used(receipt(9)), "{name}");
        }
    }

    #[test]
    fn missing_disputed_or_unavailable_evidence_fails_closed() {
        let mut c = setup();
        dispatch(&mut c);
        // `get_active_claim` returns null for an unknown or disputed receipt.
        assert!(!answer(&mut c, 1, receipt(9), Ok(None)));
        assert!(!answer(&mut c, 1, receipt(9), Err(PromiseError::Failed)));
        assert_eq!(budget(&c), (U128(0), U128(60), U128(40)));
        assert_eq!(state(&c, 1), ReservationState::Dispatched);
    }

    #[test]
    fn one_receipt_settles_at_most_one_reservation() {
        let mut c = setup();
        // Two equal 30-unit obligations: the same receipt must not settle both.
        ctx("agent.testnet", NearToken::from_near(1), 11);
        c.reserve(action(30, 2, Some(BATTLE)));
        ctx("user.testnet", one(), 12);
        c.cancel_reservation(user(), LOCAL, REQ);
        ctx("agent.testnet", NearToken::from_near(1), 13);
        c.reserve(action(30, 3, Some(BATTLE)));
        for req in [2u8, 3] {
            ctx("agent.testnet", one(), 20);
            c.dispatch(user(), LOCAL, [req; 32]);
        }
        assert!(answer(&mut c, 2, receipt(9), Ok(Some(claim(30)))));
        assert!(!answer(&mut c, 3, receipt(9), Ok(Some(claim(30)))));
        assert_eq!(state(&c, 3), ReservationState::Dispatched);
        assert_eq!(budget(&c), (U128(30), U128(30), U128(40)));
        // A distinct receipt settles the other one.
        assert!(answer(&mut c, 3, receipt(8), Ok(Some(claim(30)))));
        assert_eq!(budget(&c), (U128(60), U128(0), U128(40)));
    }

    #[test]
    #[should_panic(expected = "Cannot dispatch reservation")]
    fn an_obligation_without_a_battle_cannot_be_dispatched() {
        let mut c = setup();
        ctx("agent.testnet", NearToken::from_near(1), 11);
        c.reserve(action(10, 2, None));
        ctx("agent.testnet", one(), 20);
        c.dispatch(user(), LOCAL, [2; 32]);
    }

    #[test]
    fn only_the_user_or_delegate_can_dispatch_or_flag() {
        let callers = [
            "auditor.testnet",
            "owner.testnet",
            "executor.testnet",
            "registry.testnet",
        ];
        let mut c = setup();
        for caller in callers {
            ctx(caller, one(), 20);
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                c.dispatch(user(), LOCAL, REQ)
            }));
            assert!(r.is_err(), "{caller} must not dispatch");
        }
        assert_eq!(state(&c, 1), ReservationState::Reserved);
        dispatch(&mut c);
        for caller in callers {
            ctx(caller, one(), 21);
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                c.mark_reconciliation(user(), LOCAL, REQ)
            }));
            assert!(r.is_err(), "{caller} must not flag reconciliation");
        }
        assert_eq!(state(&c, 1), ReservationState::Dispatched);
    }

    #[test]
    fn flagged_obligation_stays_held_and_is_consumed_by_evidence() {
        let mut c = setup();
        dispatch(&mut c);
        ctx("user.testnet", one(), 21);
        c.mark_reconciliation(user(), LOCAL, REQ);
        c.mark_reconciliation(user(), LOCAL, REQ); // idempotent
        assert_eq!(state(&c, 1), ReservationState::ReconciliationRequired);
        assert_eq!(budget(&c), (U128(0), U128(60), U128(40)));
        assert!(answer(&mut c, 1, receipt(9), Ok(Some(claim(60)))));
        assert_eq!(budget(&c), (U128(60), U128(0), U128(40)));
    }

    #[test]
    #[should_panic(expected = "Not a dispatched obligation")]
    fn an_undispatched_reservation_cannot_be_flagged() {
        let mut c = setup();
        ctx("user.testnet", one(), 21);
        c.mark_reconciliation(user(), LOCAL, REQ);
    }

    #[test]
    #[should_panic(expected = "Grant revoked")]
    fn revocation_blocks_new_dispatch_admission() {
        let mut c = setup();
        ctx("user.testnet", one(), 15);
        c.revoke_grant(LOCAL);
        ctx("agent.testnet", one(), 20);
        c.dispatch(user(), LOCAL, REQ);
    }

    #[test]
    #[should_panic(expected = "Grant version changed")]
    fn replacement_cannot_revive_a_queued_expired_authorization() {
        let mut c = setup();
        ctx("user.testnet", NearToken::from_near(1), 1_000_000);
        c.create_grant(grant_input(2, "replacement-agent.testnet", 2_000_000));
        ctx("replacement-agent.testnet", one(), 1_000_001);
        c.dispatch(user(), LOCAL, REQ);
    }

    #[test]
    #[should_panic(expected = "Cannot dispatch reservation")]
    fn an_expired_reservation_is_not_admitted_for_dispatch() {
        let mut c = setup_with_expiry(u64::MAX / 2);
        ctx("agent.testnet", one(), 10 + 3_600_000_000_000);
        c.dispatch(user(), LOCAL, REQ);
    }

    #[test]
    fn dispatched_obligation_is_never_released_by_cancel_expiry_or_revocation() {
        let mut c = setup();
        dispatch(&mut c);
        ctx("user.testnet", one(), 21);
        c.revoke_grant(LOCAL);
        let late = 10 + 10 * 3_600_000_000_000;
        for caller in ["user.testnet", "agent.testnet"] {
            ctx(caller, one(), late);
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                c.cancel_reservation(user(), LOCAL, REQ)
            }));
            assert!(
                r.is_err(),
                "{caller} must not cancel a dispatched obligation"
            );
        }
        ctx("auditor.testnet", one(), late);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.release_expired(user(), LOCAL, REQ)
        }));
        assert!(r.is_err());
        assert_eq!(budget(&c), (U128(0), U128(60), U128(40)));
        assert_eq!(state(&c, 1), ReservationState::Dispatched);
    }

    #[test]
    fn replaced_and_revoked_grant_keeps_dispatched_obligation_reconcilable() {
        let mut c = setup();
        dispatch(&mut c);
        ctx("user.testnet", NearToken::from_near(1), 30);
        c.create_grant(grant_input(2, "replacement-agent.testnet", 2_000_000));
        ctx("user.testnet", one(), 31);
        c.revoke_grant(LOCAL);
        // A repeat dispatch is not a fresh admission and is not blocked by the new state.
        ctx("user.testnet", one(), 2_000_001);
        c.dispatch(user(), LOCAL, REQ);
        c.mark_reconciliation(user(), LOCAL, REQ);
        assert!(answer(&mut c, 1, receipt(9), Ok(Some(claim(60)))));
        assert_eq!(budget(&c), (U128(60), U128(0), U128(40)));
        assert_eq!(
            c.get_reservation(user(), LOCAL, REQ).unwrap().version,
            U64(1)
        );
    }

    #[test]
    #[should_panic(expected = "Grant asset cannot change")]
    fn consumed_budget_cannot_be_relabelled_by_asset_replacement() {
        let mut c = setup();
        dispatch(&mut c);
        assert!(answer(&mut c, 1, receipt(9), Ok(Some(claim(60)))));
        ctx("user.testnet", NearToken::from_near(1), 40);
        let mut replacement = grant_input(2, "agent.testnet", 2_000_000);
        replacement.asset.chain_id = U64(1);
        c.create_grant(replacement);
    }
}

/// Fixture-only no-execution release, to exercise the transition production deliberately lacks.
#[cfg(feature = "sandbox-fixtures")]
mod fixture_release {
    use super::account;
    use crate::contract::{ActionInput, AssetInput, BattleInput, GrantInput, PlayerPolicy};
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
        let mut c = PlayerPolicy::new(account("owner.testnet"), account("registry.testnet"));
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
            battle: Some(BattleInput {
                battle_id: U64(5),
                community: None,
            }),
        });
        ctx("agent.testnet", NearToken::from_yoctonear(1), 20);
        c.dispatch(account("user.testnet"), LOCAL, REQ);
        c
    }

    #[test]
    fn executor_releases_a_flagged_obligation_as_not_executed() {
        let mut c = setup();
        ctx("agent.testnet", NearToken::from_yoctonear(1), 21);
        c.mark_reconciliation(account("user.testnet"), LOCAL, REQ);
        ctx("executor.testnet", NearToken::from_yoctonear(1), 22);
        c.fixture_release_not_executed(account("user.testnet"), LOCAL, REQ);
        let b = c.get_budget(account("user.testnet"), LOCAL).unwrap();
        assert_eq!((b.reserved, b.available), (U128(0), U128(100)));
        assert_eq!(
            c.get_reservation(account("user.testnet"), LOCAL, REQ)
                .unwrap()
                .state,
            ReservationState::Released
        );
    }

    #[test]
    #[should_panic(expected = "Only executor")]
    fn the_delegate_cannot_use_the_fixture_release() {
        let mut c = setup();
        ctx("agent.testnet", NearToken::from_yoctonear(1), 21);
        c.mark_reconciliation(account("user.testnet"), LOCAL, REQ);
        c.fixture_release_not_executed(account("user.testnet"), LOCAL, REQ);
    }

    #[test]
    #[should_panic(expected = "Wrong state")]
    fn an_unflagged_dispatched_obligation_cannot_be_released() {
        let mut c = setup();
        ctx("executor.testnet", NearToken::from_yoctonear(1), 22);
        c.fixture_release_not_executed(account("user.testnet"), LOCAL, REQ);
    }
}
