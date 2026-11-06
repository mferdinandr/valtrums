mod common;

use common::*;
use serde_json::{json, Value};

/// The full happy path: two communities, one round, a winner, and a losing
/// vault that becomes entitlements and is paid out. The backing ledger
/// invariant must hold at every checkpoint.
#[tokio::test]
async fn a_full_battle_pays_the_winning_community_and_conserves_funds() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user("alice").await?; // creator, winner community
    let bob = env.user("bob").await?; // winner community
    let carol = env.user("carol").await?; // losing community

    // custody on the backing contracts: 1000 units each
    env.grant_representation(&alice, &env.backing_a, 1000, 1).await?;
    env.grant_representation(&bob, &env.backing_a, 1000, 2).await?;
    env.grant_representation(&carol, &env.backing_b, 1000, 3).await?;

    let id = env.create_and_audit(&alice).await?;
    assert_eq!(env.status(id).await?, "Approved");

    // deposits: winner community 0 gets 1000 (500/500), loser 1000
    env.deposit(&alice, &env.backing_a, 500, id, 0).await?.into_result()?;
    env.deposit(&bob, &env.backing_a, 500, id, 0).await?.into_result()?;
    env.deposit(&carol, &env.backing_b, 1000, id, 1).await?.into_result()?;
    assert_eq!(
        env.battle(id).await?["communities"][0]["vault"].as_str(),
        Some("1000")
    );
    assert_eq!(
        env.battle(id).await?["communities"][1]["vault"].as_str(),
        Some("1000")
    );
    assert!(env.invariant_holds(&env.backing_a).await?);
    assert!(env.invariant_holds(&env.backing_b).await?);

    env.lock(id).await?;
    assert_eq!(env.status(id).await?, "Live");
    env.submit_prices(id, 110, 105).await?;
    env.resolve(id).await?;
    assert_eq!(env.status(id).await?, "Settled");
    assert_eq!(env.battle(id).await?["winner"], json!(0));

    // the losing vault (community 1, 1000 units) becomes the reward pool:
    // fee = floor(1000/1000) = 1, winner pool 999, creator 0, protocol 1.
    env.arena_call(&env.auditor, "allocate_loser", json!({ "battle_id": id, "community_index": 1 }))
        .await?
        .into_result()?;
    let ledger = env.ledger(&env.backing_b).await?;
    assert_eq!(ledger["entitlements"].as_str(), Some("1000"), "ledger: {ledger}");
    assert_eq!(ledger["disposals_reserved"].as_str(), Some("0"));
    assert!(env.invariant_holds(&env.backing_b).await?);
    // the arena's representations were burned: M dropped by the vault
    assert_eq!(env.balance(&env.backing_b, env.arena.id()).await?, 0);
    assert_eq!(env.balance(&env.backing_b, &carol.id().clone()).await?, 0);

    // winner shares by locked units (500/500): largest remainder gives the
    // unit to the canonically smaller account (alice).
    let alice_entitled = env
        .backing_b
        .view("entitlement_of")
        .args_json(json!({ "battle_id": id, "account_id": alice.id() }))
        .await?
        .json::<String>()?
        .parse::<u128>()?;
    let bob_entitled = env
        .backing_b
        .view("entitlement_of")
        .args_json(json!({ "battle_id": id, "account_id": bob.id() }))
        .await?
        .json::<String>()?
        .parse::<u128>()?;
    assert_eq!((alice_entitled, bob_entitled), (500, 499));
    // protocol fee entitlement
    let protocol_entitled = env
        .backing_b
        .view("entitlement_of")
        .args_json(json!({ "battle_id": id, "account_id": env.protocol.id() }))
        .await?
        .json::<String>()?
        .parse::<u128>()?;
    assert_eq!(protocol_entitled, 1);

    // both winners register recipients and request their payouts
    for (who, q) in [(&alice, 500u128), (&bob, 499)] {
        who.call(env.arena.id(), "register_recipient")
            .args_json(json!({ "address": format!("0x{}", "cd".repeat(20)) }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        env.arena_call(
            who,
            "request_payout",
            json!({
                "battle_id": id,
                "community_index": 1,
                "beneficiary": who.id(),
                "q": q.to_string(),
            }),
        )
        .await?
        .into_result()?;
    }

    let payout_1: Value = env
        .backing_b
        .view("payout")
        .args_json(json!({ "payout_id": 0 }))
        .await?
        .json()?;
    let payout_2: Value = env
        .backing_b
        .view("payout")
        .args_json(json!({ "payout_id": 1 }))
        .await?
        .json()?;
    assert_eq!(payout_1["amount"].as_str(), Some("500"));
    assert_eq!(payout_2["amount"].as_str(), Some("499"));
    assert_eq!(payout_1["kind"].as_str(), Some("Reward"));
    assert!(env.invariant_holds(&env.backing_b).await?);

    // the verifier broadcasts and confirms the on-chain execution evidence
    for payout in [&payout_1, &payout_2] {
        let payout_id = payout["id"].as_u64().unwrap_or_default();
        env.auditor
            .call(env.backing_b.id(), "mark_broadcast")
            .args_json(json!({ "payout_id": payout_id, "tx_hash": format!("0x{payout_id}") }))
            .transact()
            .await?
            .into_result()?;
        env.auditor
            .call(env.backing_b.id(), "confirm_payout")
            .args_json(json!({
                "payout_id": payout_id,
                "evidence": {
                    "success": true,
                    "executed_movement": true,
                    "chain_id": CHAIN_ID,
                    "tx_hash": format!("0x{payout_id}"),
                    "finality": "final",
                },
            }))
            .transact()
            .await?
            .into_result()?;
    }

    // custody consumed exactly the paid amounts; P empty; invariant holds
    let ledger = env.ledger(&env.backing_b).await?;
    assert_eq!(ledger["custody"].as_str(), Some("1"), "ledger: {ledger}");
    assert_eq!(ledger["payouts_reserved"].as_str(), Some("0"));
    // only the protocol's 1-unit fee entitlement remains un-reserved
    assert_eq!(ledger["entitlements"].as_str(), Some("1"));
    assert!(env.invariant_holds(&env.backing_b).await?);
    Ok(())
}

/// A custody receipt can only be verified once; replays are refused.
#[tokio::test]
async fn custody_receipts_cannot_be_replayed() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user("alice").await?;
    env.grant_representation(&alice, &env.backing_a, 500, 1).await?;
    assert_eq!(env.balance(&env.backing_a, &alice.id().clone()).await?, 500);

    let replay = env
        .auditor
        .call(env.backing_a.id(), "verify_receipt")
        .args_json(json!({
            "receipt": { "chain_id": CHAIN_ID, "tx_hash": format!("0x{}-1", alice.id()), "log_index": 1 },
            "received_src": "500",
            "src_decimals": DECIMALS,
            "origin": alice.id(),
        }))
        .transact()
        .await?
        .into_result();
    assert!(replay.is_err(), "replayed receipt must be refused");
    assert!(env.invariant_holds(&env.backing_a).await?);
    Ok(())
}

/// Deposits after lock are refused and the representations are refunded to
/// the sender.
#[tokio::test]
async fn deposits_after_lock_are_refunded() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user("alice").await?;
    let bob = env.user("bob").await?;
    env.grant_representation(&alice, &env.backing_a, 1000, 1).await?;
    env.grant_representation(&bob, &env.backing_a, 1000, 2).await?;
    env.grant_representation(&alice, &env.backing_b, 1000, 3).await?;

    let id = env.create_and_audit(&alice).await?;
    env.deposit(&alice, &env.backing_a, 500, id, 0).await?.into_result()?;
    env.deposit(&alice, &env.backing_b, 500, id, 1).await?.into_result()?;
    env.lock(id).await?;

    let before = env.balance(&env.backing_a, &bob.id().clone()).await?;
    env.deposit(&bob, &env.backing_a, 700, id, 0).await?.into_result()?;
    let after = env.balance(&env.backing_a, &bob.id().clone()).await?;
    assert_eq!(before, after, "late deposit must be fully refunded");
    assert!(env.invariant_holds(&env.backing_a).await?);
    Ok(())
}

/// A tied round extends into a fresh round with reset inputs; only the tied
/// leaders advance. A second, decisive round ends the battle.
#[tokio::test]
async fn tied_rounds_extend_until_a_single_winner() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user("alice").await?;
    env.grant_representation(&alice, &env.backing_a, 500, 1).await?;
    env.grant_representation(&alice, &env.backing_b, 500, 2).await?;

    let id = env.create_and_audit(&alice).await?;
    env.deposit(&alice, &env.backing_a, 500, id, 0).await?.into_result()?;
    env.deposit(&alice, &env.backing_b, 500, id, 1).await?.into_result()?;
    env.lock(id).await?;

    // round 1: identical scores -> tie, no winner
    env.submit_tied_prices(id).await?;
    env.resolve(id).await?;
    let battle = env.battle(id).await?;
    assert_eq!(battle["status"].as_str(), Some("Live"));
    assert_eq!(battle["round"].as_u64(), Some(2));
    assert!(battle["winner"].is_null());

    // round 2: decisive -> settled
    env.submit_prices(id, 120, 110).await?;
    env.resolve(id).await?;
    assert_eq!(env.status(id).await?, "Settled");
    assert_eq!(env.battle(id).await?["winner"], json!(0));
    Ok(())
}

/// A battle whose audit is rejected can never lock.
#[tokio::test]
async fn audit_rejection_blocks_locking() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user("alice").await?;
    let id = env.create_and_audit(&alice).await?;

    let critical = json!({
        "chain_id": CHAIN_ID,
        "token_address": "0xa",
        "provider_version": "v1",
        "policy_version": 1,
        "queried_at_ns": env.now().await?.to_string(),
        "is_honeypot": "True",
        "cannot_sell_all": "False",
        "cannot_buy": "False",
        "buy_tax": 0,
        "sell_tax": 0,
        "transfer_tax": 0,
        "coverage_complete": true,
        "tax_policy_resolved": false,
        "evidence_hash": "h",
    });
    env.arena_call(
        &env.auditor,
        "submit_audit",
        json!({
            "battle_id": id,
            "community_index": 0,
            "goplus": critical,
            "lp": env.lp_pass().await?,
        }),
    )
    .await?
    .into_result()?;
    assert_eq!(env.status(id).await?, "Rejected");
    let refused = env.lock(id).await;
    assert!(refused.is_err(), "lock on a rejected battle must fail");
    Ok(())
}