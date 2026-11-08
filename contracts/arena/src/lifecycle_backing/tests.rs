use super::*;
use crate::lifecycle::{Battle, FeePolicy, ScoringMode};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

fn account(name: &str) -> AccountId {
    name.parse().expect("account")
}
fn asset(index: u8) -> AssetIdentity {
    AssetIdentity {
        chain_id: 46630,
        token_address: format!("0x{index:040x}"),
        representation: account(&format!("token{index}.testnet")),
        custody_domain: "vault".into(),
        reference_chain_id: None,
        reference_address: None,
    }
}
fn view_asset(index: u8) -> RepresentationAsset {
    RepresentationAsset {
        chain_id: U64(46630),
        token_address: format!("0x{index:040x}"),
        custody_domain: "vault".into(),
    }
}
fn healthy() -> RepresentationLedger {
    RepresentationLedger {
        accounting_balanced: true,
        paused: false,
        reconciliation_required: false,
    }
}
fn context(caller: &str, deposit: NearToken, now_ms: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(account("arena.testnet"))
        .predecessor_account_id(account(caller))
        .attached_deposit(deposit)
        .block_timestamp(now_ms * 1_000_000)
        .build());
}
fn panics<F: FnOnce()>(f: F) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
}

/// Fixture responses only: they say nothing about real custody.
fn arena() -> Arena {
    context("owner.testnet", NearToken::from_yoctonear(0), 0);
    let mut arena = Arena::new(
        account("owner.testnet"),
        account("usdc.testnet"),
        account("treasury.testnet"),
        U128(0),
        U64(60),
    );
    context("owner.testnet", NearToken::from_yoctonear(1), 0);
    arena.add_agent(account("agent.testnet"));
    let fee = FeePolicy {
        fee_bps: 10,
        creator_share_bps: 5000,
        creator: account("creator.testnet"),
        protocol: account("protocol.testnet"),
        protocol_created: false,
    };
    let battle =
        Battle::new(vec![asset(1), asset(2)], ScoringMode::PriceGain, fee).expect("battle");
    arena.lifecycle_insert(battle).expect("insert");
    arena
}

#[test]
fn matching_balanced_answers_make_an_expiring_approval() {
    let approval =
        evaluate_backing(&asset(1), Ok(view_asset(1)), Ok(healthy()), 1_000, 7).expect("approval");
    assert_eq!(approval.asset, asset(1));
    assert_eq!(approval.expires_at_ms, 1_000 + BACKING_APPROVAL_MS);
    assert!(approval.evidence_hash.starts_with("sha256:"));
    assert!(approval.evidence_hash.len() <= 256);
    // Evidence differs per block.
    let later =
        evaluate_backing(&asset(1), Ok(view_asset(1)), Ok(healthy()), 1_000, 8).expect("ok");
    assert_ne!(later.evidence_hash, approval.evidence_hash);
}

#[test]
fn any_mismatch_failure_or_suspension_yields_no_approval() {
    let go = |a: Result<RepresentationAsset, PromiseError>,
              l: Result<RepresentationLedger, PromiseError>| {
        evaluate_backing(&asset(1), a, l, 0, 0)
    };
    assert!(go(Ok(view_asset(2)), Ok(healthy())).is_none());
    let mut chain = view_asset(1);
    chain.chain_id = U64(1);
    assert!(go(Ok(chain), Ok(healthy())).is_none());
    let mut domain = view_asset(1);
    domain.custody_domain = "other".into();
    assert!(go(Ok(domain), Ok(healthy())).is_none());
    for ledger in [
        RepresentationLedger {
            accounting_balanced: false,
            ..healthy()
        },
        RepresentationLedger {
            paused: true,
            ..healthy()
        },
        RepresentationLedger {
            reconciliation_required: true,
            ..healthy()
        },
    ] {
        assert!(go(Ok(view_asset(1)), Ok(ledger)).is_none());
    }
    assert!(go(Err(PromiseError::Failed), Ok(healthy())).is_none());
    assert!(go(Ok(view_asset(1)), Err(PromiseError::Failed)).is_none());
    assert!(evaluate_backing(&asset(1), Ok(view_asset(1)), Ok(healthy()), u64::MAX, 0).is_none());
}

#[test]
fn only_the_owner_with_one_yocto_changes_the_trust_list() {
    let mut arena = arena();
    let rep = account("token1.testnet");
    assert!(!arena.is_lifecycle_representation_trusted(rep.clone()));
    for (caller, deposit) in [
        ("agent.testnet", 1),
        ("anyone.testnet", 1),
        ("owner.testnet", 0),
        ("owner.testnet", 2),
    ] {
        context(caller, NearToken::from_yoctonear(deposit), 0);
        assert!(panics(
            || arena.set_lifecycle_representation_trusted(rep.clone(), true)
        ));
    }
    context("owner.testnet", NearToken::from_yoctonear(1), 0);
    arena.set_lifecycle_representation_trusted(rep.clone(), true);
    assert!(arena.is_lifecycle_representation_trusted(rep.clone()));
    arena.set_lifecycle_representation_trusted(rep.clone(), false);
    assert!(!arena.is_lifecycle_representation_trusted(rep));
}

#[test]
fn refresh_needs_an_agent_a_deposit_a_trusted_representation_and_an_open_battle() {
    let mut arena = arena();
    context("owner.testnet", NearToken::from_yoctonear(1), 0);
    arena.set_lifecycle_representation_trusted(account("token1.testnet"), true);
    context("anyone.testnet", NearToken::from_near(1), 0);
    assert!(panics(|| {
        let _ = arena.refresh_lifecycle_backing(1, 0);
    }));
    context("agent.testnet", NearToken::from_yoctonear(0), 0);
    assert!(panics(|| {
        let _ = arena.refresh_lifecycle_backing(1, 0);
    }));
    context("agent.testnet", NearToken::from_near(1), 0);
    assert!(panics(|| {
        let _ = arena.refresh_lifecycle_backing(2, 0);
    }));
    assert!(panics(|| {
        let _ = arena.refresh_lifecycle_backing(1, 5);
    }));
    // Community 1 has an untrusted representation.
    assert!(panics(|| {
        let _ = arena.refresh_lifecycle_backing(1, 1);
    }));
    let _ = arena.refresh_lifecycle_backing(1, 0);
}

#[test]
fn the_callback_stores_withdraws_and_never_stores_unpaid_or_failed_answers() {
    let mut arena = arena();
    let store = |arena: &mut Arena,
                 deposit: NearToken,
                 asset: Result<RepresentationAsset, PromiseError>,
                 ledger: Result<RepresentationLedger, PromiseError>| {
        context("arena.testnet", deposit, 5_000);
        arena.on_lifecycle_backing_checked(1, 0, account("agent.testnet"), asset, ledger)
    };
    let backing = |arena: &Arena| {
        arena
            .get_lifecycle_battle(1)
            .map(|view| view.communities[0].backing_evidence_hash.clone())
    };
    // Not enough deposit for the storage: nothing is stored.
    assert!(!store(
        &mut arena,
        NearToken::from_yoctonear(1),
        Ok(view_asset(1)),
        Ok(healthy())
    ));
    assert_eq!(backing(&arena), Some(None));
    // Paid: stored.
    assert!(store(
        &mut arena,
        NearToken::from_near(1),
        Ok(view_asset(1)),
        Ok(healthy())
    ));
    let stored = backing(&arena).expect("view").expect("evidence");
    assert!(stored.starts_with("sha256:"));
    // An unavailable representation withdraws the approval.
    assert!(!store(
        &mut arena,
        NearToken::from_near(1),
        Err(PromiseError::Failed),
        Ok(healthy())
    ));
    assert_eq!(backing(&arena), Some(None));
    // A suspended representation withdraws it too.
    assert!(store(
        &mut arena,
        NearToken::from_near(1),
        Ok(view_asset(1)),
        Ok(healthy())
    ));
    assert!(!store(
        &mut arena,
        NearToken::from_near(1),
        Ok(view_asset(1)),
        Ok(RepresentationLedger {
            paused: true,
            ..healthy()
        })
    ));
    assert_eq!(backing(&arena), Some(None));
}
