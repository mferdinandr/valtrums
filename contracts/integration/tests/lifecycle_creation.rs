mod common;

use near_workspaces::types::NearToken;
use near_workspaces::Account;
use serde_json::{json, Value};

// Fixture evidence and mock tokens exercise the NEAR contract only. They are not
// a live audit or backing result, so these tests do not establish either.

fn asset(index: u32, representation: &str) -> Value {
    json!({
        "chain_id": "46630",
        "token_address": format!("0x{index:040x}"),
        "representation": representation,
        "custody_domain": "fixture",
    })
}

async fn create(
    env: &common::Env,
    creator: &Account,
    assets: Vec<Value>,
) -> anyhow::Result<Result<u64, ()>> {
    let result = creator
        .call(env.arena.id(), "create_lifecycle_battle")
        .args_json(json!({ "mode": "PriceGain", "assets": assets }))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result();
    Ok(match result {
        Ok(created) => Ok(created.json()?),
        Err(_) => Err(()),
    })
}

async fn activate(env: &common::Env) -> anyhow::Result<()> {
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
    Ok(())
}

#[tokio::test]
async fn two_and_three_communities_are_created_and_invalid_identities_are_rejected(
) -> anyhow::Result<()> {
    let env = common::Env::new(60, false).await?;
    activate(&env).await?;
    let creator = env.user("creation-creator").await?;
    let pepe = env.pepe.id().to_string();
    let shib = env.shib.id().to_string();
    let usdc = env.usdc.id().to_string();
    let third = "third.test.near";

    let two = create(&env, &creator, vec![asset(1, &pepe), asset(2, &shib)])
        .await?
        .expect("two communities");
    let three = create(
        &env,
        &creator,
        vec![asset(1, &pepe), asset(2, &shib), asset(3, third)],
    )
    .await?
    .expect("three communities");
    for (id, count) in [(two, 2), (three, 3)] {
        let view = env
            .arena_view("get_lifecycle_battle", json!({ "battle_id": id }))
            .await?;
        assert_eq!(view["communities"].as_array().map(Vec::len), Some(count));
        assert_eq!(view["locked"], false);
        assert_eq!(view["creator"], json!(creator.id()));
        assert_eq!(view["protocol_created"], false);
    }

    let mut upper = asset(2, &shib);
    upper["token_address"] = json!(format!("0x{:040X}", 1));
    let mut bad_address = asset(2, &shib);
    bad_address["token_address"] = json!("0x01");
    let mut blank_domain = asset(2, &shib);
    blank_domain["custody_domain"] = json!(" ");
    let invalid: Vec<(&str, Vec<Value>)> = vec![
        ("no community", vec![]),
        ("one community", vec![asset(1, &pepe)]),
        (
            "duplicate token address",
            vec![asset(1, &pepe), asset(1, &shib)],
        ),
        (
            "duplicate address in another letter case",
            vec![asset(1, &pepe), upper],
        ),
        (
            "duplicate representation",
            vec![asset(1, &pepe), asset(2, &pepe)],
        ),
        ("malformed address", vec![asset(1, &pepe), bad_address]),
        ("blank custody domain", vec![asset(1, &pepe), blank_domain]),
        (
            "legacy USDC as representation",
            vec![asset(1, &pepe), asset(2, &usdc)],
        ),
        (
            "more communities than the limit",
            (1..=17)
                .map(|i| asset(i, &format!("rep-{i}.test.near")))
                .collect(),
        ),
    ];
    for (name, assets) in invalid {
        assert!(
            create(&env, &creator, assets).await?.is_err(),
            "{name} was accepted"
        );
    }
    // Only the two valid battles exist.
    assert!(env
        .arena_view("get_lifecycle_battle", json!({ "battle_id": three + 1 }))
        .await?
        .is_null());
    Ok(())
}

/// Fixture-only wasm is built separately so normal artifacts never acquire the
/// fixture methods.
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

async fn lock(env: &common::Env, id: u64) -> anyhow::Result<bool> {
    Ok(env
        .agent
        .call(env.arena.id(), "lock_lifecycle_battle")
        .args_json(json!({ "battle_id": id }))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .is_ok())
}

async fn deposit(
    env: &common::Env,
    user: &Account,
    token: &near_workspaces::Contract,
    id: u64,
    community: u32,
    amount: u128,
) -> anyhow::Result<()> {
    env.transfer_call(
        user,
        token,
        env.arena.id(),
        amount,
        json!({"action": "lifecycle_deposit", "battle_id": id, "community": community}),
    )
    .await?
    .into_result()?;
    Ok(())
}

async fn vault(env: &common::Env, id: u64, community: usize) -> anyhow::Result<String> {
    let view = env
        .arena_view("get_lifecycle_battle", json!({ "battle_id": id }))
        .await?;
    Ok(view["communities"][community]["vault"]
        .as_str()
        .unwrap_or_default()
        .to_string())
}

#[tokio::test]
async fn fixture_lock_requires_approvals_nonempty_vaults_and_creator_stake() -> anyhow::Result<()> {
    let env = common::Env::new(60, false).await?;
    env.arena
        .as_account()
        .deploy(&fixture_arena_wasm()?)
        .await?
        .into_result()?;
    activate(&env).await?;
    let creator = env.user("req-creator").await?;
    let player = env.user("req-player").await?;
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
    env.register(&third, creator.id()).await?;
    let pepe = env.pepe.id().to_string();
    let shib = env.shib.id().to_string();
    let id = create(
        &env,
        &creator,
        vec![
            asset(1, &pepe),
            asset(2, &shib),
            asset(3, third.id().as_str()),
        ],
    )
    .await?
    .expect("battle");
    for (community, user) in [(0, &creator), (1, &player), (2, &player), (1, &creator)] {
        user.call(env.arena.id(), "register_lifecycle_position")
            .args_json(json!({"battle_id": id, "community": community}))
            .deposit(NearToken::from_near(1))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    env.mint(&env.pepe, creator.id(), 100).await?;
    env.mint(&env.shib, player.id(), 100).await?;
    env.mint(&third, player.id(), 100).await?;
    env.mint(&env.shib, creator.id(), 100).await?;

    // Missing approvals: with none, or only some, a transfer is returned and
    // nothing can lock.
    deposit(&env, &creator, &env.pepe, id, 0, 7).await?;
    assert_eq!(env.balance(&env.pepe, creator.id()).await?, 100);
    for community in [0u32, 1] {
        env.arena
            .call("fixture_approve_lifecycle")
            .args_json(json!({"battle_id": id, "community": community}))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    deposit(&env, &creator, &env.pepe, id, 0, 7).await?;
    assert_eq!(env.balance(&env.pepe, creator.id()).await?, 100);
    assert!(!lock(&env, id).await?);
    env.arena
        .call("fixture_approve_lifecycle")
        .args_json(json!({"battle_id": id, "community": 2}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // Empty vaults: only the creator's community has funds.
    deposit(&env, &creator, &env.pepe, id, 0, 7).await?;
    assert_eq!(vault(&env, id, 0).await?, "7");
    assert!(!lock(&env, id).await?);
    deposit(&env, &player, &env.shib, id, 1, 11).await?;
    assert!(!lock(&env, id).await?, "community 2 is still empty");

    // Absent creator stake: a second battle where only the player deposits.
    let other = create(
        &env,
        &creator,
        vec![
            asset(1, &pepe),
            asset(2, &shib),
            asset(3, third.id().as_str()),
        ],
    )
    .await?
    .expect("second battle");
    for community in 0..3u32 {
        player
            .call(env.arena.id(), "register_lifecycle_position")
            .args_json(json!({"battle_id": other, "community": community}))
            .deposit(NearToken::from_near(1))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        env.arena
            .call("fixture_approve_lifecycle")
            .args_json(json!({"battle_id": other, "community": community}))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    env.mint(&env.pepe, player.id(), 100).await?;
    deposit(&env, &player, &env.pepe, other, 0, 3).await?;
    deposit(&env, &player, &env.shib, other, 1, 3).await?;
    deposit(&env, &player, &third, other, 2, 3).await?;
    for community in 0..3 {
        assert_eq!(vault(&env, other, community).await?, "3");
    }
    assert!(!lock(&env, other).await?, "no creator position");
    let view = env
        .arena_view("get_lifecycle_battle", json!({ "battle_id": other }))
        .await?;
    assert_eq!(view["locked"], false);

    // The same battle locks once the creator holds a credited position.
    env.register(&env.pepe, creator.id()).await.ok();
    creator
        .call(env.arena.id(), "register_lifecycle_position")
        .args_json(json!({"battle_id": other, "community": 0}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    deposit(&env, &creator, &env.pepe, other, 0, 5).await?;
    assert!(lock(&env, other).await?);
    let view = env
        .arena_view("get_lifecycle_battle", json!({ "battle_id": other }))
        .await?;
    assert_eq!(view["locked"], true);

    // Finally the first battle locks with all vaults filled.
    deposit(&env, &player, &third, id, 2, 13).await?;
    assert!(lock(&env, id).await?);
    assert_eq!(vault(&env, id, 2).await?, "13");
    Ok(())
}
