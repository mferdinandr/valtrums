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
            { "chain_id": "46630", "token_address": "0x0000000000000000000000000000000000000001", "representation": env.pepe.id(), "custody_domain": "fixture" },
            { "chain_id": "46630", "token_address": "0x0000000000000000000000000000000000000002", "representation": env.shib.id(), "custody_domain": "fixture" }
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
        "lifecycle_losing_vault",
        "fixture_approve_lifecycle",
        "fixture_hold_lifecycle_principal",
        "fixture_credit_lifecycle",
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
        json!({"policy": {"version": "1", "policy_hash": "fixture-policy"}}),
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

/// Fixture-only wasm is built separately so normal contract artifacts never
/// acquire the fixture methods. It proves NEAR behavior, not foreign custody.
fn fixture_arena_wasm() -> anyhow::Result<Vec<u8>> {
    let workspace = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace")
        .to_path_buf();
    let target = workspace.join("target/lifecycle-fixtures");
    let status = common::cargo_wasm_build()
        .current_dir(&workspace)
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "-p",
            "valtrum-arena",
            "--features",
            "sandbox-fixtures",
            "--target-dir",
        ])
        .arg(&target)
        .status()?;
    anyhow::ensure!(status.success(), "fixture wasm build failed");
    Ok(std::fs::read(target.join(
        "wasm32-unknown-unknown/release/valtrum_arena.wasm",
    ))?)
}

#[tokio::test]
async fn fixture_deposits_freeze_and_principal_stays_held() -> anyhow::Result<()> {
    let env = common::Env::new(60, false).await?;
    env.arena
        .as_account()
        .deploy(&fixture_arena_wasm()?)
        .await?
        .into_result()?;
    let creator = env.user("fixture-creator").await?;
    let player = env.user("fixture-player").await?;
    let third = env
        .worker
        .dev_deploy(&common::wasm("valtrum_mock_ft"))
        .await?;
    third
        .call("new")
        .args_json(json!({"name": "Fixture third", "symbol": "THIRD", "decimals": 18}))
        .transact()
        .await?
        .into_result()?;
    env.register(&third, env.arena.id()).await?;
    env.register(&third, player.id()).await?;
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
    env.arena_call_yocto(
        &env.owner,
        "set_lifecycle_observation_policy",
        json!({"policy": {"version": "1", "policy_hash": "fixture-policy"}}),
    )
    .await?
    .into_result()?;
    let created = creator.call(env.arena.id(), "create_lifecycle_battle")
        .args_json(json!({ "mode": "PriceGain", "assets": [
            { "chain_id": "46630", "token_address": "0x0000000000000000000000000000000000000001", "representation": env.pepe.id(), "custody_domain": "fixture" },
            { "chain_id": "46630", "token_address": "0x0000000000000000000000000000000000000002", "representation": env.shib.id(), "custody_domain": "fixture" },
            { "chain_id": "46630", "token_address": "0x0000000000000000000000000000000000000003", "representation": third.id(), "custody_domain": "fixture" }
        ] })).deposit(NearToken::from_near(1)).max_gas().transact().await?.into_result()?;
    let id: u64 = created.json()?;
    for (index, user) in [(0, &creator), (1, &player), (2, &player)] {
        user.call(env.arena.id(), "register_lifecycle_position")
            .args_json(json!({"battle_id": id, "community": index}))
            .deposit(NearToken::from_near(1))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        let unauthorized = user
            .call(env.arena.id(), "fixture_approve_lifecycle")
            .args_json(json!({"battle_id": id, "community": index}))
            .max_gas()
            .transact()
            .await?;
        assert!(unauthorized.into_result().is_err());
        env.arena
            .call("fixture_approve_lifecycle")
            .args_json(json!({"battle_id": id, "community": index}))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    env.mint(&env.pepe, creator.id(), 20).await?;
    env.mint(&env.shib, player.id(), 30).await?;
    env.mint(&third, player.id(), 40).await?;
    for (index, user, token, amount) in [
        (0, &creator, &env.pepe, 7),
        (1, &player, &env.shib, 11),
        (2, &player, &third, 13),
    ] {
        env.transfer_call(
            user,
            token,
            env.arena.id(),
            amount,
            json!({"action": "lifecycle_deposit", "battle_id": id, "community": index}),
        )
        .await?
        .into_result()?;
    }
    env.agent
        .call(env.arena.id(), "lock_lifecycle_battle")
        .args_json(json!({"battle_id": id}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let before = env
        .arena_view("get_lifecycle_battle", json!({"battle_id": id}))
        .await?;
    assert_eq!(before["locked"], true);
    assert_eq!(before["communities"][0]["vault"], "7");
    assert_eq!(before["communities"][1]["vault"], "11");
    assert_eq!(before["communities"][2]["vault"], "13");
    let late_audit = env
        .arena
        .call("fixture_approve_lifecycle")
        .args_json(json!({"battle_id": id, "community": 0}))
        .max_gas()
        .transact()
        .await?;
    assert!(late_audit.into_result().is_err());
    env.agent
        .call(env.arena.id(), "lock_lifecycle_battle")
        .args_json(json!({"battle_id": id}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        env.arena_view("get_lifecycle_battle", json!({"battle_id": id}))
            .await?,
        before
    );
    env.transfer_call(
        &creator,
        &env.pepe,
        env.arena.id(),
        5,
        json!({"action": "lifecycle_deposit", "battle_id": id, "community": 0}),
    )
    .await?
    .into_result()?;
    assert_eq!(env.balance(&env.pepe, creator.id()).await?, 13);
    assert_eq!(
        env.arena_view("get_lifecycle_battle", json!({"battle_id": id}))
            .await?,
        before
    );
    env.arena
        .call("fixture_hold_lifecycle_principal")
        .args_json(json!({"battle_id": id, "winner": 0}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let held = env
        .arena_view("get_lifecycle_battle", json!({"battle_id": id}))
        .await?;
    assert_eq!(held["principal_community"], 0);
    assert_eq!(held["principal_amount"], "7");
    assert_eq!(env.balance(&env.pepe, env.arena.id()).await?, 7);
    assert_eq!(env.balance(&env.shib, env.arena.id()).await?, 11);
    assert_eq!(env.balance(&third, env.arena.id()).await?, 13);
    for actor in [&env.owner, &env.agent] {
        let withdrawal = actor
            .call(env.arena.id(), "withdraw_liquid")
            .args_json(json!({"token": env.pepe.id(), "amount": "7"}))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?;
        assert!(withdrawal.into_result().is_err());
    }
    assert_eq!(env.balance(&env.pepe, env.arena.id()).await?, 7);
    let conflicting = env
        .arena
        .call("fixture_hold_lifecycle_principal")
        .args_json(json!({"battle_id": id, "winner": 1}))
        .max_gas()
        .transact()
        .await?;
    assert!(conflicting.into_result().is_err());
    Ok(())
}

/// Measures the worst permitted community count using synthetic fixture
/// positions. This is not a custody or live-network gas guarantee.
#[tokio::test]
async fn fixture_sixteen_community_lock_fits_sandbox_gas() -> anyhow::Result<()> {
    let env = common::Env::new(60, false).await?;
    env.arena
        .as_account()
        .deploy(&fixture_arena_wasm()?)
        .await?
        .into_result()?;
    let creator = env.user("gas-creator").await?;
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
    env.arena_call_yocto(
        &env.owner,
        "set_lifecycle_observation_policy",
        json!({"policy": {"version": "1", "policy_hash": "p".repeat(256)}}),
    )
    .await?
    .into_result()?;
    let assets: Vec<_> = (0..16).map(|i| json!({"chain_id": "46630", "token_address": format!("0x{:040x}", i + 1), "representation": format!("representation-{i}.test.near"), "custody_domain": "d".repeat(256)})).collect();
    let created = creator
        .call(env.arena.id(), "create_lifecycle_battle")
        .args_json(json!({"mode": "PriceGain", "assets": assets}))
        .deposit(NearToken::from_near(2))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let id: u64 = created.json()?;
    for index in 0..16 {
        creator
            .call(env.arena.id(), "register_lifecycle_position")
            .args_json(json!({"battle_id": id, "community": index}))
            .deposit(NearToken::from_near(1))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        env.arena
            .call("fixture_approve_lifecycle")
            .args_json(json!({"battle_id": id, "community": index}))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    for index in 0..16 {
        env.arena.call("fixture_credit_lifecycle").args_json(json!({"battle_id": id, "community": index, "account": creator.id(), "token": format!("representation-{index}.test.near"), "amount": "1"}))
            .max_gas().transact().await?.into_result()?;
    }
    let lock = env
        .agent
        .call(env.arena.id(), "lock_lifecycle_battle")
        .args_json(json!({"battle_id": id}))
        .deposit(NearToken::from_near(2))
        .max_gas()
        .transact()
        .await?;
    let gas = lock.total_gas_burnt;
    lock.into_result()?;
    eprintln!("16-community fixture lock: {gas:?}");
    let battle = env
        .arena_view("get_lifecycle_battle", json!({"battle_id": id}))
        .await?;
    assert_eq!(battle["locked"], true);
    assert_eq!(
        battle["communities"].as_array().expect("communities").len(),
        16
    );
    Ok(())
}
