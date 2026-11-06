use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use near_sdk::{NearToken, PromiseOrValue};

use crate::types::*;
use crate::{Arena, BackingPayout, BackingPayoutKind, ObservationKind, ROUND_SECS};

fn acc(name: &str) -> near_sdk::AccountId {
    format!("{name}.testnet").parse().unwrap()
}

fn as_value(value: PromiseOrValue<U128>) -> U128 {
    match value {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("unexpected promise"),
    }
}

fn token(symbol: &str) -> TokenIdentity {
    TokenIdentity {
        chain_id: 46630,
        token_address: format!("0x{symbol}").to_lowercase(),
        backing: acc(&format!("backing_{symbol}")),
        decimals: 8,
        custody_domain: format!("custody.{symbol}.testnet"),
        symbol: symbol.to_string(),
    }
}

fn ctx(account: &str, now_ns: u64) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .predecessor_account_id(acc(account))
        .current_account_id(acc("arena"))
        .block_timestamp(now_ns)
        .attached_deposit(NearToken::from_yoctonear(1));
    builder
}

fn new_arena(now_ns: u64) -> Arena {
    testing_env!(ctx("owner", now_ns).build());
    let mut arena = Arena::new(acc("owner"), acc("protocol"));
    arena.add_worker(acc("worker"));
    arena.set_policy(1, "policy-hash-1".to_string());
    arena
}

fn goplus_pass() -> crate::types::GoPlusEvidence {
    goplus_for("0xa")
}

fn goplus_for(token_address: &str) -> crate::types::GoPlusEvidence {
    crate::types::GoPlusEvidence {
        chain_id: 46630,
        token_address: token_address.to_string(),
        provider_version: "fixture-v1".to_string(),
        policy_version: 1,
        queried_at_ns: U64(1_000),
        is_honeypot: TriState::False,
        cannot_sell_all: TriState::False,
        cannot_buy: TriState::False,
        buy_tax: Some(0),
        sell_tax: Some(0),
        transfer_tax: Some(0),
        coverage_complete: true,
        tax_policy_resolved: false,
        evidence_hash: "h".to_string(),
    }
}

fn lp_pass() -> crate::types::LpEvidence {
    crate::types::LpEvidence {
        usd_value_scaled: U128(10_001 * 1_000_000),
        source: "fixture".to_string(),
        observed_at_ns: U64(1_000),
        evidence_hash: "h".to_string(),
    }
}

fn deposit(arena: &mut Arena, battle_id: u64, community: u16, who: &str, amount: u128, now: u64) {
    let msg = format!("{{\"battle_id\": {battle_id}, \"community_index\": {community}}}");
    let backing = if community == 0 {
        "backing_a"
    } else if community == 1 {
        "backing_b"
    } else {
        "backing_c"
    };
    testing_env!(ctx(who, now).predecessor_account_id(acc(backing)).build());
    let returned = arena.ft_on_transfer(acc(who), U128(amount), msg);
    assert_eq!(as_value(returned).0, 0, "deposit not accepted");
}

fn submit_audit(arena: &mut Arena, battle_id: u64, community: u16, now: u64) {
    testing_env!(ctx("worker", now).build());
    let address = if community == 0 {
        "0xa"
    } else if community == 1 {
        "0xb"
    } else {
        "0xc"
    };
    arena.submit_audit(battle_id, community, goplus_for(address), lp_pass());
}

#[test]
fn create_battle_requires_two_distinct_communities() {
    let mut arena = new_arena(0);
    testing_env!(ctx("alice", 0).build());
    let id = arena.create_battle(ScoringMode::PriceGain, vec![token("a"), token("b")], false);
    assert_eq!(id, 1);
    let battle = arena.battle(id).unwrap();
    assert_eq!(battle.status, BattleStatus::Proposed);
    assert!(!battle.protocol_created);

    let one = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        arena.create_battle(ScoringMode::PriceGain, vec![token("a")], false)
    }));
    assert!(one.is_err());
}

#[test]
fn protocol_battles_require_protocol_creator() {
    let mut arena = new_arena(0);
    testing_env!(ctx("alice", 0).build());
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        arena.create_battle(ScoringMode::PriceGain, vec![token("a"), token("b")], true)
    }));
    assert!(refused.is_err());
    testing_env!(ctx("protocol", 0).build());
    let id = arena.create_battle(ScoringMode::PriceGain, vec![token("a"), token("b")], true);
    assert!(arena.battle(id).unwrap().protocol_created);
}

#[test]
fn audit_approves_rejects_and_holds_pending() {
    let mut arena = new_arena(0);
    testing_env!(ctx("alice", 0).build());
    let id = arena.create_battle(ScoringMode::PriceGain, vec![token("a"), token("b")], false);

    // One Pass, one missing: still Proposed.
    submit_audit(&mut arena, id, 0, 1_000);
    assert_eq!(arena.battle(id).unwrap().status, BattleStatus::Proposed);

    // Second community Pass: Approved.
    testing_env!(ctx("worker", 1_000).build());
    arena.submit_audit(id, 1, goplus_for("0xb"), lp_pass());
    assert_eq!(arena.battle(id).unwrap().status, BattleStatus::Approved);

    // Reject overrides: honeypot on a third re-audit rejects the battle.
    let critical = crate::types::GoPlusEvidence {
        is_honeypot: TriState::True,
        ..goplus_pass()
    };
    arena.submit_audit(id, 0, critical, lp_pass());
    assert_eq!(arena.battle(id).unwrap().status, BattleStatus::Rejected);
}

#[test]
fn deposit_locks_vault_and_position_and_late_deposit_refunds() {
    let mut arena = new_arena(0);
    testing_env!(ctx("alice", 0).build());
    let id = arena.create_battle(ScoringMode::PriceGain, vec![token("a"), token("b")], false);
    submit_audit(&mut arena, id, 0, 1_000);
    submit_audit(&mut arena, id, 1, 1_000);

    deposit(&mut arena, id, 0, "alice", 1_000, 2_000);
    deposit(&mut arena, id, 1, "carol", 500, 2_000);
    assert_eq!(arena.battle(id).unwrap().communities[0].vault, U128(1_000));
    assert_eq!(arena.position(id, 0, acc("alice")), U128(1_000));

    // Late deposit after lock is returned in full.
    testing_env!(ctx("worker", 2_000).build());
    arena.lock(id);
    let msg = "{\"battle_id\": 1, \"community_index\": 0}".to_string();
    testing_env!(ctx("bob", 3_000)
        .predecessor_account_id(acc("backing_a"))
        .build());
    let returned = arena.ft_on_transfer(acc("bob"), U128(500), msg);
    assert_eq!(as_value(returned).0, 500);
}

#[test]
fn lock_requires_creator_stake_and_positive_vaults() {
    let mut arena = new_arena(0);
    testing_env!(ctx("alice", 0).build());
    let id = arena.create_battle(ScoringMode::PriceGain, vec![token("a"), token("b")], false);
    submit_audit(&mut arena, id, 0, 1_000);
    submit_audit(&mut arena, id, 1, 1_000);

    // Creator with no stake: cannot lock.
    deposit(&mut arena, id, 0, "bob", 1_000, 2_000);
    deposit(&mut arena, id, 1, "carol", 1_000, 2_000);
    testing_env!(ctx("worker", 2_000).build());
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| arena.lock(id)));
    assert!(refused.is_err());

    // Creator deposits: lock succeeds.
    deposit(&mut arena, id, 0, "alice", 500, 2_000);
    testing_env!(ctx("worker", 2_000).build());
    arena.lock(id);
    let battle = arena.battle(id).unwrap();
    assert_eq!(battle.status, BattleStatus::Live);
    assert_eq!(battle.round, 1);
    assert!(battle.policy_ref.is_some());
    assert_eq!(battle.candidates, vec![0, 1]);

    // Repeated lock is a no-op.
    arena.lock(id);
    assert_eq!(arena.battle(id).unwrap().round, 1);
}

#[test]
fn resolve_round_advances_tied_leaders_only() {
    let mut arena = new_arena(0);
    testing_env!(ctx("alice", 0).build());
    let id = arena.create_battle(
        ScoringMode::PriceGain,
        vec![token("a"), token("b"), token("c")],
        false,
    );
    submit_audit(&mut arena, id, 0, 1_000);
    submit_audit(&mut arena, id, 1, 1_000);
    submit_audit(&mut arena, id, 2, 1_000);
    deposit(&mut arena, id, 0, "alice", 500, 2_000);
    deposit(&mut arena, id, 1, "bob", 500, 2_000);
    deposit(&mut arena, id, 2, "carol", 500, 2_000);
    testing_env!(ctx("worker", 2_000).build());
    arena.lock(id);

    // Round 1: A +10%, B +10%, C +2% -> A/B tie, C eliminated.
    testing_env!(ctx("worker", 2_000).build());
    for index in [0u16, 1, 2] {
        arena.submit_observation(id, index, ObservationKind::StartPrice { price: U128(100) });
    }
    arena.submit_observation(id, 0, ObservationKind::EndPrice { price: U128(110) });
    arena.submit_observation(id, 1, ObservationKind::EndPrice { price: U128(110) });
    arena.submit_observation(id, 2, ObservationKind::EndPrice { price: U128(102) });

    testing_env!(ctx("worker", 2_000 + ROUND_SECS * 1_000_000_000).build());
    arena.resolve_round(id);
    let battle = arena.battle(id).unwrap();
    assert_eq!(battle.status, BattleStatus::Live);
    assert_eq!(battle.round, 2);
    assert_eq!(battle.candidates, vec![0, 1]);
    assert!(battle.communities[2].eliminated);

    // Round 2 fresh inputs: A -4%, B -5% -> A wins.
    testing_env!(ctx("worker", 2_000 + ROUND_SECS * 1_000_000_000).build());
    arena.submit_observation(id, 0, ObservationKind::StartPrice { price: U128(100) });
    arena.submit_observation(id, 1, ObservationKind::StartPrice { price: U128(100) });
    arena.submit_observation(id, 0, ObservationKind::EndPrice { price: U128(96) });
    arena.submit_observation(id, 1, ObservationKind::EndPrice { price: U128(95) });

    testing_env!(ctx("worker", 2_000 + 2 * ROUND_SECS * 1_000_000_000).build());
    arena.resolve_round(id);
    let battle = arena.battle(id).unwrap();
    assert_eq!(battle.status, BattleStatus::Settled);
    assert_eq!(battle.winner, Some(0));
    assert!(battle.escrow.is_some());
    assert_eq!(battle.escrow.as_ref().unwrap().principal, U128(500));
}

#[test]
fn resolve_round_refuses_incomplete_evidence() {
    let mut arena = new_arena(0);
    testing_env!(ctx("alice", 0).build());
    let id = arena.create_battle(ScoringMode::PriceGain, vec![token("a"), token("b")], false);
    submit_audit(&mut arena, id, 0, 1_000);
    submit_audit(&mut arena, id, 1, 1_000);
    deposit(&mut arena, id, 0, "alice", 500, 2_000);
    deposit(&mut arena, id, 1, "bob", 500, 2_000);
    testing_env!(ctx("worker", 2_000).build());
    arena.lock(id);

    // Only start prices: missing end prices hold the round pending.
    testing_env!(ctx("worker", 2_000).build());
    arena.submit_observation(id, 0, ObservationKind::StartPrice { price: U128(100) });
    arena.submit_observation(id, 1, ObservationKind::StartPrice { price: U128(100) });
    testing_env!(ctx("worker", 2_000 + ROUND_SECS * 1_000_000_000).build());
    let refused =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| arena.resolve_round(id)));
    assert!(refused.is_err());
    assert_eq!(arena.battle(id).unwrap().status, BattleStatus::Live);
}

#[test]
fn drawdown_mode_selects_lowest_drawdown() {
    let mut arena = new_arena(0);
    testing_env!(ctx("alice", 0).build());
    let id = arena.create_battle(
        ScoringMode::LowestDrawdown,
        vec![token("a"), token("b")],
        false,
    );
    submit_audit(&mut arena, id, 0, 1_000);
    submit_audit(&mut arena, id, 1, 1_000);
    deposit(&mut arena, id, 0, "alice", 500, 2_000);
    deposit(&mut arena, id, 1, "bob", 500, 2_000);
    testing_env!(ctx("worker", 2_000).build());
    arena.lock(id);

    testing_env!(ctx("worker", 2_000).build());
    arena.submit_observation(
        id,
        0,
        ObservationKind::Path {
            prices: vec![U128(100), U128(95), U128(105), U128(100)],
        },
    );
    arena.submit_observation(
        id,
        1,
        ObservationKind::Path {
            prices: vec![U128(100), U128(95), U128(90), U128(100)],
        },
    );
    testing_env!(ctx("worker", 2_000 + ROUND_SECS * 1_000_000_000).build());
    arena.resolve_round(id);
    let battle = arena.battle(id).unwrap();
    assert_eq!(battle.winner, Some(0));
}

#[test]
fn grants_create_revoke_and_deposit_spend() {
    let mut arena = new_arena(0);
    testing_env!(ctx("alice", 0).build());
    let grant_id = arena.create_grant(
        acc("agent"),
        vec![(acc("backing_a"), U128(1_000))],
        vec!["deposit".to_string()],
        vec![46630],
        vec![acc("backing_a")],
        U64(1_000_000),
    );
    let grant = arena.grant(grant_id).unwrap();
    assert_eq!(grant.grantor, acc("alice"));
    assert!(!grant.revoked);

    let id = arena.create_battle(ScoringMode::PriceGain, vec![token("a"), token("b")], false);
    submit_audit(&mut arena, id, 0, 1_000);
    submit_audit(&mut arena, id, 1, 1_000);

    // Agent deposit under grant spends the grant budget.
    let msg = format!("{{\"battle_id\": {id}, \"community_index\": 0, \"grant_id\": {grant_id}}}");
    testing_env!(ctx("agent", 2_000)
        .predecessor_account_id(acc("backing_a"))
        .build());
    let returned = arena.ft_on_transfer(acc("agent"), U128(400), msg);
    assert_eq!(as_value(returned).0, 0);
    assert_eq!(arena.grant(grant_id).unwrap().budget[0].1, U128(600));

    // Revoked grant cannot spend more.
    testing_env!(ctx("alice", 2_000).build());
    arena.revoke_grant(grant_id);
    let msg = format!("{{\"battle_id\": {id}, \"community_index\": 0, \"grant_id\": {grant_id}}}");
    testing_env!(ctx("agent", 2_000)
        .predecessor_account_id(acc("backing_a"))
        .build());
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        arena.ft_on_transfer(acc("agent"), U128(100), msg)
    }));
    assert!(refused.is_err());
}

#[test]
fn recipient_registration_and_payout_registry() {
    let mut arena = new_arena(0);
    testing_env!(ctx("alice", 0).build());
    arena.register_recipient("0x2626664c2603336E57B271c5C0b26F421741e481".to_string());
    assert_eq!(
        arena.recipient(acc("alice")),
        Some("0x2626664c2603336E57B271c5C0b26F421741e481".to_string())
    );

    // The arena registers payout reservations from the backing callback.
    let id = arena.create_battle(ScoringMode::PriceGain, vec![token("a"), token("b")], false);
    let payout = BackingPayout {
        id: 42,
        battle_id: id,
        beneficiary: acc("alice"),
        amount: U128(1_000),
        kind: BackingPayoutKind::Reward,
        nonce: 42,
    };
    arena.on_payout_reserved(id, 0, Ok(payout));
    let sign_request = arena.payout_context(42);
    assert_eq!(
        sign_request.map(|(battle_id, beneficiary, amount, nonce, _)| {
            (battle_id, beneficiary.to_string(), amount, nonce)
        }),
        Some((id, "alice.testnet".to_string(), 1_000, 42))
    );
}

#[test]
fn dao_decision_gates_disposal_state() {
    let mut arena = new_arena(0);
    testing_env!(ctx("alice", 0).build());
    let id = arena.create_battle(ScoringMode::PriceGain, vec![token("a"), token("b")], false);
    submit_audit(&mut arena, id, 0, 1_000);
    submit_audit(&mut arena, id, 1, 1_000);
    deposit(&mut arena, id, 0, "alice", 500, 2_000);
    deposit(&mut arena, id, 1, "bob", 500, 2_000);
    testing_env!(ctx("worker", 2_000).build());
    arena.lock(id);
    // Distinct end prices: A wins round 1.
    testing_env!(ctx("worker", 2_000).build());
    arena.submit_observation(id, 0, ObservationKind::StartPrice { price: U128(100) });
    arena.submit_observation(id, 1, ObservationKind::StartPrice { price: U128(100) });
    arena.submit_observation(id, 0, ObservationKind::EndPrice { price: U128(110) });
    arena.submit_observation(id, 1, ObservationKind::EndPrice { price: U128(105) });
    testing_env!(ctx("worker", 2_000 + ROUND_SECS * 1_000_000_000).build());
    arena.resolve_round(id);
    assert_eq!(arena.battle(id).unwrap().status, BattleStatus::Settled);
    assert!(arena.escrow(id).is_some());

    // No decision: nothing may be disposed.
    testing_env!(ctx("owner", 3_000).build());
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = arena.dispose_principal(id);
    }));
    assert!(refused.is_err());

    // Decision recorded (owner-gated until a DAO is designed), then
    // disposal reservation is requested against the backing contract.
    arena.record_decision(id, DisposalKind::Burn, "fixture-governance-1".to_string());
    assert!(arena.decision(id).is_some());
    let promise =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| arena.dispose_principal(id)));
    // dispose_principal starts a cross-contract promise; with no mock
    // backing deployed the promise is returned and state flips to Disposing.
    assert!(promise.is_ok());
    assert_eq!(arena.escrow(id).unwrap().status, EscrowStatus::Disposing);
}
