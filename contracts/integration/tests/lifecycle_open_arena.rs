mod common;

use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

// Sandbox checks of the open arena. Fixture approvals and mock tokens prove NEAR
// behavior only; they are not a live audit, backing or custody result.

/// The commit whose arena wasm is the "previous main" for the state-compat test.
const PREVIOUS_MAIN: &str = "32a96ae3ba764a4c0a36165aadaa03cbac327e2e";

fn workspace() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace")
        .to_path_buf()
}

fn fixture_arena_wasm() -> anyhow::Result<Vec<u8>> {
    let target = workspace().join("target/lifecycle-fixtures");
    let status = common::cargo_wasm_build()
        .current_dir(workspace())
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

/// Builds the arena wasm of `PREVIOUS_MAIN` from a clean export of that commit.
fn previous_arena_wasm() -> anyhow::Result<Vec<u8>> {
    let root = workspace().join("target/previous-main");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root)?;
    let archive = std::process::Command::new("git")
        .current_dir(workspace())
        .args(["archive", PREVIOUS_MAIN, "."])
        .output()?;
    anyhow::ensure!(archive.status.success(), "git archive failed");
    let src = root.join("src");
    std::fs::create_dir_all(&src)?;
    let tar = root.join("export.tar");
    std::fs::write(&tar, &archive.stdout)?;
    let status = std::process::Command::new("tar")
        .arg("-xf")
        .arg(&tar)
        .arg("-C")
        .arg(&src)
        .status()?;
    anyhow::ensure!(status.success(), "tar failed");
    let target = root.join("target");
    let status = common::cargo_wasm_build()
        .current_dir(&src)
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "-p",
            "valtrum-arena",
            "--target-dir",
        ])
        .arg(&target)
        .status()?;
    anyhow::ensure!(status.success(), "previous wasm build failed");
    Ok(std::fs::read(target.join(
        "wasm32-unknown-unknown/release/valtrum_arena.wasm",
    ))?)
}

fn yocto() -> NearToken {
    NearToken::from_yoctonear(1)
}

fn asset(index: u32, representation: &str) -> Value {
    json!({
        "chain_id": "46630",
        "token_address": format!("0x{index:040x}"),
        "representation": representation,
        "custody_domain": "fixture",
    })
}

async fn now_ms(env: &common::Env) -> anyhow::Result<u64> {
    Ok(env.worker.view_block().await?.timestamp() / 1_000_000)
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

async fn list(env: &common::Env, index: u32, representation: &str) -> anyhow::Result<()> {
    env.arena_call_yocto(
        &env.treasury,
        "set_lifecycle_joinable_asset",
        json!({ "asset": asset(index, representation) }),
    )
    .await?
    .into_result()?;
    Ok(())
}

async fn create(
    env: &common::Env,
    creator: &Account,
    assets: Vec<Value>,
    start_at_ms: Option<u64>,
) -> anyhow::Result<Option<u64>> {
    let result = creator
        .call(env.arena.id(), "create_lifecycle_battle")
        .args_json(json!({
            "assets": assets,
            "mode": "PriceGain",
            "start_at_ms": start_at_ms.map(|v| v.to_string()),
        }))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result();
    Ok(match result {
        Ok(done) => Some(done.json()?),
        Err(_) => None,
    })
}

async fn join(
    env: &common::Env,
    who: &Account,
    id: u64,
    representation: &str,
) -> anyhow::Result<Option<u32>> {
    let result = who
        .call(env.arena.id(), "join_lifecycle_battle")
        .args_json(json!({"battle_id": id, "representation": representation}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result();
    Ok(result.ok().map(|r| r.json().expect("index")))
}

async fn approve(env: &common::Env, id: u64, community: u32) -> anyhow::Result<()> {
    env.arena
        .call("fixture_approve_lifecycle")
        .args_json(json!({"battle_id": id, "community": community}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn lock(env: &common::Env, id: u64, expected: Option<u32>) -> anyhow::Result<bool> {
    Ok(env
        .agent
        .call(env.arena.id(), "lock_lifecycle_battle")
        .args_json(json!({"battle_id": id, "expected_communities": expected}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .is_ok())
}

async fn view(env: &common::Env, id: u64) -> anyhow::Result<Value> {
    env.arena_view("get_lifecycle_battle", json!({ "battle_id": id }))
        .await
}

async fn deposit(
    env: &common::Env,
    user: &Account,
    token: &Contract,
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

async fn fixture_env() -> anyhow::Result<common::Env> {
    let env = common::Env::new(60, false).await?;
    env.arena
        .as_account()
        .deploy(&fixture_arena_wasm()?)
        .await?
        .into_result()?;
    activate(&env).await?;
    Ok(env)
}

#[tokio::test]
async fn open_arena_from_creation_to_lock_with_an_excluded_community() -> anyhow::Result<()> {
    let env = fixture_env().await?;
    let pepe = env.pepe.id().to_string();
    let shib = env.shib.id().to_string();
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
    let third_id = third.id().to_string();
    list(&env, 1, &pepe).await?;
    list(&env, 2, &shib).await?;
    list(&env, 3, &third_id).await?;
    let listed = env
        .arena_view(
            "get_lifecycle_joinable_assets",
            json!({"from_index": "0", "limit": "10"}),
        )
        .await?;
    assert_eq!(listed.as_array().map(Vec::len), Some(3));
    assert!(env
        .arena_view(
            "get_lifecycle_joinable_asset",
            json!({"representation": pepe})
        )
        .await?
        .is_object());

    let creator = env.user("open-creator").await?;
    let alice = env.user("open-alice").await?;
    // Start times outside 1 minute to 7 days are refused; a valid one is stored.
    let now = now_ms(&env).await?;
    assert!(create(&env, &creator, vec![], Some(now + 10_000))
        .await?
        .is_none());
    assert!(create(&env, &creator, vec![], Some(now + 8 * 86_400_000))
        .await?
        .is_none());
    let start = now + 150_000;
    let id = create(&env, &creator, vec![], Some(start))
        .await?
        .expect("open arena");
    assert_eq!(view(&env, id).await?["start_at_ms"], start.to_string());
    assert_eq!(view(&env, id).await?["cancelled"], false);
    assert_eq!(
        env.arena_view("get_lifecycle_start", json!({"battle_id": id}))
            .await?,
        json!(start.to_string())
    );

    // A token that was not listed cannot join.
    assert!(join(&env, &alice, id, "unlisted.test.near")
        .await?
        .is_none());
    assert_eq!(join(&env, &creator, id, &pepe).await?, Some(0));
    assert_eq!(join(&env, &alice, id, &shib).await?, Some(1));
    assert_eq!(join(&env, &alice, id, &third_id).await?, Some(2));
    // A second joiner of pepe reuses community 0.
    assert_eq!(join(&env, &alice, id, &pepe).await?, Some(0));
    assert_eq!(
        view(&env, id).await?["communities"]
            .as_array()
            .map(Vec::len),
        Some(3)
    );

    // Only approved communities take deposits; the third stays unapproved and empty.
    approve(&env, id, 0).await?;
    approve(&env, id, 1).await?;
    env.mint(&env.pepe, creator.id(), 100).await?;
    env.mint(&env.shib, alice.id(), 100).await?;
    env.mint(&third, alice.id(), 100).await?;
    env.register(&third, alice.id()).await.ok();
    deposit(&env, &creator, &env.pepe, id, 0, 10).await?;
    deposit(&env, &alice, &env.shib, id, 1, 20).await?;
    deposit(&env, &alice, &third, id, 2, 30).await?;
    assert_eq!(
        env.balance(&third, alice.id()).await?,
        100,
        "unapproved target"
    );
    // Lock before the start time is refused.
    assert!(!lock(&env, id, Some(3)).await?);
    env.advance_to(start * 1_000_000).await?;
    // At or after the start, deposits and joins are refused.
    env.mint(&env.pepe, alice.id(), 5).await?;
    deposit(&env, &alice, &env.pepe, id, 0, 5).await.ok();
    assert_eq!(env.balance(&env.pepe, alice.id()).await?, 5);
    // A stale expected count fails; the right one locks and excludes community 2.
    assert!(!lock(&env, id, Some(2)).await?);
    assert!(lock(&env, id, Some(3)).await?);
    let locked = view(&env, id).await?;
    assert_eq!(locked["locked"], true);
    assert_eq!(locked["communities"][0]["vault"], "10");
    assert_eq!(locked["communities"][1]["vault"], "20");
    assert_eq!(locked["communities"][2]["vault"], "0");
    Ok(())
}

#[tokio::test]
async fn cancel_then_refund_pays_once_and_a_failed_transfer_restores_the_position(
) -> anyhow::Result<()> {
    let env = fixture_env().await?;
    let pepe = env.pepe.id().to_string();
    list(&env, 1, &pepe).await?;
    let creator = env.user("refund-creator").await?;
    let alice = env.user("refund-alice").await?;
    let now = now_ms(&env).await?;
    let start = now + 120_000;
    let id = create(&env, &creator, vec![], Some(start))
        .await?
        .expect("open arena");
    join(&env, &creator, id, &pepe).await?;
    join(&env, &alice, id, &pepe).await?;
    approve(&env, id, 0).await?;
    env.mint(&env.pepe, creator.id(), 10).await?;
    env.mint(&env.pepe, alice.id(), 7).await?;
    deposit(&env, &creator, &env.pepe, id, 0, 10).await?;
    deposit(&env, &alice, &env.pepe, id, 0, 7).await?;
    // Cancel is refused early and while two communities are funded is irrelevant here.
    let early = env
        .arena_call(&alice, "cancel_lifecycle_battle", json!({"battle_id": id}))
        .await?;
    assert!(early.into_result().is_err());
    // Refund before cancel is refused.
    let premature = alice
        .call(env.arena.id(), "claim_lifecycle_refund")
        .args_json(json!({"battle_id": id, "community": 0}))
        .deposit(yocto())
        .max_gas()
        .transact()
        .await?;
    assert!(premature.into_result().is_err());
    env.advance_to(start * 1_000_000).await?;
    env.arena_call(&alice, "cancel_lifecycle_battle", json!({"battle_id": id}))
        .await?
        .into_result()?;
    assert!(env
        .arena_view("is_lifecycle_cancelled", json!({"battle_id": id}))
        .await?
        .as_bool()
        .unwrap_or(false));
    assert!(!lock(&env, id, None).await?);
    assert_eq!(join(&env, &alice, id, &pepe).await?, None);

    // Creator is paid back exactly once.
    let claim = |who: &Account| {
        who.call(env.arena.id(), "claim_lifecycle_refund")
            .args_json(json!({"battle_id": id, "community": 0}))
            .deposit(yocto())
            .max_gas()
            .transact()
    };
    claim(&creator).await?.into_result()?;
    assert_eq!(env.balance(&env.pepe, creator.id()).await?, 10);
    assert!(claim(&creator).await?.into_result().is_err());
    assert_eq!(env.balance(&env.pepe, creator.id()).await?, 10);
    assert_eq!(view(&env, id).await?["communities"][0]["vault"], "7");

    // Alice leaves the token's registry, so her payout fails and is rolled back.
    alice
        .call(env.pepe.id(), "storage_unregister")
        .args_json(json!({"force": true}))
        .deposit(yocto())
        .transact()
        .await?
        .into_result()?;
    claim(&alice).await?.into_result()?;
    let position = env
        .arena_view(
            "get_lifecycle_position",
            json!({"battle_id": id, "community": 0, "account": alice.id()}),
        )
        .await?;
    assert_eq!(position["amount"], "7");
    assert_eq!(view(&env, id).await?["communities"][0]["vault"], "7");
    // Registered again, the same claim succeeds once.
    env.register(&env.pepe, alice.id()).await?;
    claim(&alice).await?.into_result()?;
    assert_eq!(env.balance(&env.pepe, alice.id()).await?, 7);
    assert!(claim(&alice).await?.into_result().is_err());
    assert_eq!(view(&env, id).await?["communities"][0]["vault"], "0");
    Ok(())
}

#[tokio::test]
async fn gas_for_the_sixteenth_join_lock_and_settlement_with_sixteen_funded_communities(
) -> anyhow::Result<()> {
    let env = fixture_env().await?;
    let creator = env.user("gas-open-creator").await?;
    let reps: Vec<String> = (0..16).map(|i| format!("rep-{i}.test.near")).collect();
    for (i, rep) in reps.iter().enumerate() {
        list(&env, i as u32 + 1, rep).await?;
    }
    let start = now_ms(&env).await? + 100_000;
    let id = create(&env, &creator, vec![], Some(start))
        .await?
        .expect("open arena");
    let mut sixteenth = None;
    for (i, rep) in reps.iter().enumerate() {
        let result = creator
            .call(env.arena.id(), "join_lifecycle_battle")
            .args_json(json!({"battle_id": id, "representation": rep}))
            .deposit(NearToken::from_near(1))
            .max_gas()
            .transact()
            .await?;
        if i == 15 {
            sixteenth = Some(result.total_gas_burnt);
        }
        result.into_result()?;
    }
    eprintln!("16th join gas: {:?}", sixteenth);
    for index in 0..16u32 {
        approve(&env, id, index).await?;
        env.arena
            .call("fixture_credit_lifecycle")
            .args_json(
                json!({"battle_id": id, "community": index, "account": creator.id(),
                "token": reps[index as usize], "amount": "1000000"}),
            )
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    env.advance_to(start * 1_000_000).await?;
    let locked = env
        .agent
        .call(env.arena.id(), "lock_lifecycle_battle")
        .args_json(json!({"battle_id": id, "expected_communities": 16}))
        .deposit(NearToken::from_near(2))
        .max_gas()
        .transact()
        .await?;
    eprintln!("lock with 16 funded gas: {:?}", locked.total_gas_burnt);
    locked.into_result()?;
    env.arena
        .call("fixture_hold_lifecycle_principal")
        .args_json(json!({"battle_id": id, "winner": 0}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let settle = creator
        .call(env.arena.id(), "settle_lifecycle_battle")
        .args_json(json!({"battle_id": id.to_string(), "max_entitlements": 15}))
        .deposit(NearToken::from_millinear(200))
        .max_gas()
        .transact()
        .await?;
    // Backings do not exist for these fake representations, so the batch is only
    // used to measure the plan computation over 15 losing communities.
    eprintln!(
        "settle batch (15 entitlements) gas: {:?}",
        settle.total_gas_burnt
    );
    let progress = env
        .arena_view(
            "get_settlement_progress",
            json!({"battle_id": id.to_string()}),
        )
        .await?;
    assert_eq!(progress["total"], 45);
    Ok(())
}

#[tokio::test]
async fn previous_main_state_survives_a_redeploy_of_the_new_code() -> anyhow::Result<()> {
    let old_wasm = previous_arena_wasm()?;
    let env = common::Env::new(60, false).await?;
    let root = env.worker.root_account()?;
    let arena = root
        .create_subaccount("oldarena")
        .initial_balance(NearToken::from_near(30))
        .transact()
        .await?
        .into_result()?;
    let arena = arena.deploy(&old_wasm).await?.into_result()?;
    arena
        .call("new")
        .args_json(json!({
            "owner": env.owner.id(), "usdc": env.usdc.id(), "treasury": env.treasury.id(),
            "bond": "0", "deposit_window_secs": "60",
        }))
        .transact()
        .await?
        .into_result()?;
    let owner_call = |method: &'static str, args: Value| {
        env.owner
            .call(arena.id(), method)
            .args_json(args)
            .deposit(yocto())
            .max_gas()
            .transact()
    };
    owner_call("activate_lifecycle", json!({}))
        .await?
        .into_result()?;
    owner_call(
        "set_lifecycle_protocol",
        json!({"protocol": env.treasury.id()}),
    )
    .await?
    .into_result()?;
    let creator = env.user("compat-creator").await?;
    let pepe = env.pepe.id().to_string();
    let shib = env.shib.id().to_string();
    // OLD code: a two-community battle and a registered position.
    let old_id: u64 = creator
        .call(arena.id(), "create_lifecycle_battle")
        .args_json(json!({"mode": "PriceGain", "assets": [asset(1, &pepe), asset(2, &shib)]}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    creator
        .call(arena.id(), "register_lifecycle_position")
        .args_json(json!({"battle_id": old_id, "community": 0}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let before: Value = arena
        .view("get_lifecycle_battle")
        .args_json(json!({"battle_id": old_id}))
        .await?
        .json()?;
    assert_eq!(before["communities"].as_array().map(Vec::len), Some(2));
    assert!(
        before.get("start_at_ms").is_none(),
        "old ABI has no start field"
    );

    // NEW code over the same account and state.
    arena
        .as_account()
        .deploy(&common::wasm("valtrum_arena"))
        .await?
        .into_result()?;
    let after: Value = arena
        .view("get_lifecycle_battle")
        .args_json(json!({"battle_id": old_id}))
        .await?
        .json()?;
    assert_eq!(after["communities"], before["communities"]);
    assert_eq!(after["creator"], before["creator"]);
    assert_eq!(after["start_at_ms"], Value::Null);
    assert_eq!(after["cancelled"], false);
    let position: Value = arena
        .view("get_lifecycle_position")
        .args_json(json!({"battle_id": old_id, "community": 0, "account": creator.id()}))
        .await?
        .json()?;
    assert_eq!(position["registered"], true);
    let count: u64 = arena.view("get_lifecycle_battle_count").await?.json()?;
    assert_eq!(count, 1);
    let fee: Value = arena.view("get_lifecycle_fee").await?.json()?;
    assert_eq!(fee, json!([10, 5000]));

    // The new methods work on the migrated state, including on the old battle.
    env.treasury
        .call(arena.id(), "set_lifecycle_joinable_asset")
        .args_json(json!({"asset": asset(1, &pepe)}))
        .deposit(yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let bob = env.user("compat-bob").await?;
    let reused: u32 = bob
        .call(arena.id(), "join_lifecycle_battle")
        .args_json(json!({"battle_id": old_id, "representation": pepe}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(reused, 0, "the old battle's community is reused");
    let start = now_ms(&env).await? + 200_000;
    let new_id: u64 = creator
        .call(arena.id(), "create_lifecycle_battle")
        .args_json(json!({"assets": [], "mode": "PriceGain", "start_at_ms": start.to_string()}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(new_id, 2);
    let start_view: Value = arena
        .view("get_lifecycle_start")
        .args_json(json!({"battle_id": new_id}))
        .await?
        .json()?;
    assert_eq!(start_view, json!(start.to_string()));
    // The old battle is still readable after the new writes.
    let again: Value = arena
        .view("get_lifecycle_battle")
        .args_json(json!({"battle_id": old_id}))
        .await?
        .json()?;
    assert_eq!(again["communities"], before["communities"]);
    Ok(())
}
