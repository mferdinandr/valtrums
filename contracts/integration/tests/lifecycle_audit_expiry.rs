mod common;

use near_workspaces::types::NearToken;
use serde_json::{json, Value};

/// Sandbox-only checks of audit approval expiry at lock time. Fixture tokens and
/// synthetic credits prove NEAR behavior only; none of this is live GoPlus or
/// mainnet evidence. The fixture arena wasm is built separately.
fn fixture_arena_wasm() -> anyhow::Result<Vec<u8>> {
    let workspace = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace")
        .to_path_buf();
    let target = workspace.join("target/lifecycle-fixtures");
    let status = std::process::Command::new("cargo")
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

const TOKENS: [&str; 2] = [
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002",
];

struct Setup {
    env: common::Env,
    id: u64,
}

fn asset(env: &common::Env, index: usize, token: &str) -> Value {
    let representation = if index == 0 {
        env.pepe.id()
    } else {
        env.shib.id()
    };
    json!({"chain_id": "46630", "token_address": token, "representation": representation, "custody_domain": "fixture"})
}

async fn setup() -> anyhow::Result<Setup> {
    let env = common::Env::new(60, false).await?;
    env.arena
        .as_account()
        .deploy(&fixture_arena_wasm()?)
        .await?
        .into_result()?;
    let creator = env.user("expiry-creator").await?;
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
    let assets: Vec<_> = (0..2).map(|i| asset(&env, i, TOKENS[i])).collect();
    let created = creator
        .call(env.arena.id(), "create_lifecycle_battle")
        .args_json(json!({"mode": "PriceGain", "assets": assets}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let id: u64 = created.json()?;
    for index in 0..2 {
        creator
            .call(env.arena.id(), "register_lifecycle_position")
            .args_json(json!({"battle_id": id, "community": index}))
            .deposit(NearToken::from_near(1))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        // Fixture approval also records the backing evidence the lock needs.
        env.arena
            .call("fixture_approve_lifecycle")
            .args_json(json!({"battle_id": id, "community": index}))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    for index in 0..2 {
        let token = if index == 0 {
            env.pepe.id()
        } else {
            env.shib.id()
        };
        env.arena
            .call("fixture_credit_lifecycle")
            .args_json(json!({"battle_id": id, "community": index, "account": creator.id(), "token": token, "amount": "1"}))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    Ok(Setup { env, id })
}

async fn now_ms(env: &common::Env) -> anyhow::Result<u64> {
    Ok(env.worker.view_block().await?.timestamp() / 1_000_000)
}

async fn submit(
    s: &Setup,
    community: usize,
    token: &str,
    result: &str,
    policy_hash: &str,
    expires_at_ms: Option<u64>,
) -> anyhow::Result<bool> {
    let call = s
        .env
        .agent
        .call(s.env.arena.id(), "submit_lifecycle_audit")
        .args_json(json!({
            "battle_id": s.id,
            "community": community,
            "asset": asset(&s.env, community, token),
            "result": result,
            "policy_hash": policy_hash,
            "evidence_hash": format!("evidence-{community}"),
            "expires_at_ms": expires_at_ms.map(|v| v.to_string()),
        }))
        .deposit(NearToken::from_millinear(10))
        .max_gas()
        .transact()
        .await?;
    Ok(call.into_result().is_ok())
}

async fn lock(s: &Setup) -> anyhow::Result<bool> {
    Ok(s.env
        .agent
        .call(s.env.arena.id(), "lock_lifecycle_battle")
        .args_json(json!({"battle_id": s.id}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .is_ok())
}

async fn view(s: &Setup) -> anyhow::Result<Value> {
    s.env
        .arena_view("get_lifecycle_battle", json!({"battle_id": s.id}))
        .await
}

#[tokio::test]
async fn expired_approval_refuses_lock_until_refreshed_then_lock_is_idempotent(
) -> anyhow::Result<()> {
    let s = setup().await?;
    let p = "policy-v1";
    let soon = now_ms(&s.env).await? + 4_000;
    assert!(submit(&s, 0, TOKENS[0], "pass", p, Some(soon + 600_000)).await?);
    assert!(submit(&s, 1, TOKENS[1], "pass", p, Some(soon)).await?);
    assert_eq!(
        view(&s).await?["communities"][1]["audit_expires_at_ms"],
        soon.to_string()
    );
    // Wait until block time passes the expiry; blocks advance with activity.
    while now_ms(&s.env).await? < soon {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let _ = s.env.worker.fast_forward(2).await;
    }
    assert!(!lock(&s).await?, "lock must refuse an expired approval");
    assert_eq!(view(&s).await?["locked"], false);
    // A refresh with a fresh expiry lets the lock proceed; repeating it is harmless.
    let fresh = now_ms(&s.env).await? + 600_000;
    assert!(submit(&s, 1, TOKENS[1], "pass", p, Some(fresh)).await?);
    assert!(submit(&s, 1, TOKENS[1], "pass", p, Some(fresh)).await?);
    assert!(lock(&s).await?);
    let frozen = view(&s).await?;
    assert_eq!(frozen["locked"], true);
    // Repeated lock keeps the original snapshot; a later audit change is refused.
    assert!(lock(&s).await?);
    assert_eq!(view(&s).await?, frozen);
    assert!(!submit(&s, 1, TOKENS[1], "reject", p, None).await?);
    assert_eq!(view(&s).await?, frozen);
    Ok(())
}

#[tokio::test]
async fn withdrawn_approval_and_invalid_expiry_refuse_lock() -> anyhow::Result<()> {
    let s = setup().await?;
    let p = "policy-v1";
    let later = now_ms(&s.env).await? + 600_000;
    // A pass needs a future expiry within 24 hours; none, past and too far are refused.
    assert!(!submit(&s, 0, TOKENS[0], "pass", p, None).await?);
    assert!(!submit(&s, 0, TOKENS[0], "pass", p, Some(1)).await?);
    assert!(!submit(&s, 0, TOKENS[0], "pass", p, Some(later + 90_000_000)).await?);
    assert!(submit(&s, 0, TOKENS[0], "pass", p, Some(later)).await?);
    assert!(submit(&s, 1, TOKENS[1], "pass", p, Some(later)).await?);
    // Withdrawal (a pending result) removes the approval and blocks the lock.
    assert!(submit(&s, 1, TOKENS[1], "pending", p, None).await?);
    assert!(!lock(&s).await?);
    assert_eq!(view(&s).await?["locked"], false);
    assert!(submit(&s, 1, TOKENS[1], "pass", p, Some(later)).await?);
    assert!(lock(&s).await?);
    Ok(())
}

#[tokio::test]
async fn changed_asset_or_pinned_policy_refuses_lock() -> anyhow::Result<()> {
    let s = setup().await?;
    let later = now_ms(&s.env).await? + 600_000;
    // An approval for a different token address cannot replace the committed one.
    assert!(!submit(&s, 0, TOKENS[1], "pass", "policy-v1", Some(later)).await?);
    s.env
        .arena_call_yocto(
            &s.env.owner,
            "set_lifecycle_audit_policy_hash",
            json!({"policy_hash": "policy-v2"}),
        )
        .await?
        .into_result()?;
    // Approvals under policy-v1 no longer match the pinned policy.
    assert!(submit(&s, 0, TOKENS[0], "pass", "policy-v1", Some(later)).await?);
    assert!(submit(&s, 1, TOKENS[1], "pass", "policy-v1", Some(later)).await?);
    assert!(!lock(&s).await?);
    assert_eq!(view(&s).await?["locked"], false);
    assert!(submit(&s, 0, TOKENS[0], "pass", "policy-v2", Some(later)).await?);
    assert!(!lock(&s).await?, "one stale community still refuses");
    assert!(submit(&s, 1, TOKENS[1], "pass", "policy-v2", Some(later)).await?);
    assert!(lock(&s).await?);
    // Only the owner may pin the policy, with exactly one yocto.
    let denied = s
        .env
        .arena_call_yocto(
            &s.env.agent,
            "set_lifecycle_audit_policy_hash",
            json!({"policy_hash": null}),
        )
        .await?;
    assert!(denied.into_result().is_err());
    Ok(())
}
