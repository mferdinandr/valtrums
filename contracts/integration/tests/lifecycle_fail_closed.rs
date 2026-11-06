mod common;

use near_workspaces::types::NearToken;
use serde_json::json;

/// Fixture tokens exercise NEP-141 resolution; they do not prove foreign backing.
#[tokio::test]
async fn unapproved_representation_transfer_returns_to_sender() -> anyhow::Result<()> {
    let env = common::Env::new(60, false).await?;
    let alice = env.user("lifecycle-alice").await?;
    env.arena_call_yocto(&env.owner, "activate_lifecycle", json!({}))
        .await?
        .into_result()?;
    env.arena_call_yocto(
        &env.owner,
        "set_lifecycle_protocol",
        json!({"protocol": env.treasury.id()}),
    )
    .await?
    .into_result()?;
    let created = alice.call(env.arena.id(), "create_lifecycle_battle")
        .args_json(json!({ "mode": "PriceGain", "assets": [
            { "chain_id": 46630, "token_address": "0x0000000000000000000000000000000000000001", "representation": env.pepe.id(), "custody_domain": "fixture" },
            { "chain_id": 46630, "token_address": "0x0000000000000000000000000000000000000002", "representation": env.shib.id(), "custody_domain": "fixture" }
        ] }))
        .deposit(NearToken::from_near(1)).max_gas().transact().await?.into_result()?;
    let id: u64 = created.json()?;
    alice
        .call(env.arena.id(), "register_lifecycle_position")
        .args_json(json!({ "battle_id": id, "community": 0 }))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    // Rust-only helpers are deliberately absent from the deployed contract ABI.
    // An arbitrary account must not be able to invent either kind of evidence.
    for method in [
        "lifecycle_set_audit",
        "lifecycle_set_backing",
        "lifecycle_hold_principal",
    ] {
        let attempt = alice.call(env.arena.id(), method)
            .args_json(json!({"id": id, "community": 0, "winner": 0, "evidence": {"evidence_hash": "fabricated"}}))
            .max_gas().transact().await?;
        assert!(
            attempt.into_result().is_err(),
            "internal method {method} was callable"
        );
    }
    env.mint(&env.pepe, alice.id(), 100).await?;
    let arena_before = env.balance(&env.pepe, env.arena.id()).await?;
    let transfer = env
        .transfer_call(
            &alice,
            &env.pepe,
            env.arena.id(),
            100,
            json!({ "action": "lifecycle_deposit", "battle_id": id, "community": 0 }),
        )
        .await?;
    transfer.into_result()?;
    assert_eq!(env.balance(&env.pepe, alice.id()).await?, 100);
    assert_eq!(env.balance(&env.pepe, env.arena.id()).await?, arena_before);
    env.arena_call_yocto(
        &env.owner,
        "set_lifecycle_observation_policy",
        json!({"policy": {"version": 1, "policy_hash": "fixture-policy"}}),
    )
    .await?
    .into_result()?;
    let lock = env
        .agent
        .call(env.arena.id(), "lock_lifecycle_battle")
        .args_json(json!({"battle_id": id}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?;
    assert!(lock.into_result().is_err());
    let position = env
        .arena_view(
            "get_lifecycle_position",
            json!({ "battle_id": id, "community": 0, "account": alice.id() }),
        )
        .await?;
    assert_eq!(position["registered"], true);
    assert_eq!(position["amount"], "0");
    let battle = env
        .arena_view("get_lifecycle_battle", json!({ "battle_id": id }))
        .await?;
    assert_eq!(battle["locked"], false);
    assert_eq!(battle["communities"][0]["vault"], "0");
    Ok(())
}
