//! Sandbox tests for bounded player grants and atomic budget reservations. All amounts, grants and
//! actions below are synthetic fixtures: a reservation here is a policy authorization and a budget
//! hold, never a token transfer, proof of funds or confirmed payment.
mod common;

use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

const TOKEN: &str = "0x00000000000000000000000000000000000000aa";
const DEST: &str = "0x00000000000000000000000000000000000000dd";
const TARGET: &str = "router.testnet";
const FUTURE_NS: &str = "9000000000000000000";

fn b32(n: u8) -> Vec<u8> {
    vec![n; 32]
}

fn asset() -> Value {
    json!({
        "chain_id": "46630",
        "token": TOKEN,
        "representation": "aa.token.testnet",
        "custody_domain": "vault-1",
        "mapping_version": "2",
    })
}

fn grant_input(delegate: &Account, cumulative_cap: &str, expiry_ns: &str) -> Value {
    json!({"input": {
        "delegate": delegate.id(),
        "local_id": b32(7),
        "version": "1",
        "asset": asset(),
        "contracts": [TARGET],
        "methods": ["swap"],
        "destinations": [DEST],
        "battle": null,
        "per_action_cap": "100",
        "cumulative_cap": cumulative_cap,
        "gas_cap": "300",
        "expiry_ns": expiry_ns,
    }})
}

fn action(user: &Account, amount: &str, request: u8) -> Value {
    json!({"action": {
        "user": user.id(),
        "local_id": b32(7),
        "version": "1",
        "asset": asset(),
        "target": TARGET,
        "method": "swap",
        "destination": DEST,
        "amount": amount,
        "gas": "100",
        "request_id": b32(request),
        "battle": {"battle_id": "5", "community": null},
    }})
}

struct World {
    worker: near_workspaces::Worker<near_workspaces::network::Sandbox>,
    policy: Contract,
    owner: Account,
    user: Account,
    agent: Account,
    registry: Contract,
    verifier: Account,
}

async fn deploy() -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let policy = worker
        .dev_deploy(&common::wasm("valtrum_player_policy"))
        .await?;
    let owner = worker.dev_create_account().await?;
    let registry = worker
        .dev_deploy(&common::wasm("valtrum_receipt_registry"))
        .await?;
    let verifier = worker.dev_create_account().await?;
    registry
        .call("new")
        .args_json(json!({"owner": owner.id(), "verifier": verifier.id()}))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(registry.id(), "set_representation")
        .args_json(json!({"representation": "aa.token.testnet", "allowed": true}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    policy
        .call("new")
        .args_json(json!({"owner": owner.id(), "registry": registry.id()}))
        .transact()
        .await?
        .into_result()?;
    let user = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    Ok(World {
        worker,
        policy,
        owner,
        user,
        agent,
        registry,
        verifier,
    })
}

async fn create_grant(w: &World, cumulative_cap: &str, expiry_ns: &str) -> anyhow::Result<()> {
    w.user
        .call(w.policy.id(), "create_grant")
        .args_json(grant_input(&w.agent, cumulative_cap, expiry_ns))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn budget(w: &World) -> anyhow::Result<Value> {
    Ok(w.policy
        .view("get_budget")
        .args_json(json!({"user": w.user.id(), "local_id": b32(7)}))
        .await?
        .json()?)
}

#[tokio::test]
async fn user_grant_and_delegate_reservation_update_the_budget() -> anyhow::Result<()> {
    let w = deploy().await?;
    create_grant(&w, "100", FUTURE_NS).await?;
    w.agent
        .call(w.policy.id(), "reserve")
        .args_json(action(&w.user, "60", 1))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let b = budget(&w).await?;
    assert_eq!(b["reserved"], "60");
    assert_eq!(b["available"], "40");
    Ok(())
}

#[tokio::test]
async fn competing_reservations_cannot_exceed_the_cumulative_cap() -> anyhow::Result<()> {
    let w = deploy().await?;
    create_grant(&w, "100", FUTURE_NS).await?;
    // Two distinct actions of 60 submitted concurrently; 60 + 60 > 100 so at most one can win.
    let c1 = w
        .agent
        .call(w.policy.id(), "reserve")
        .args_json(action(&w.user, "60", 1))
        .deposit(NearToken::from_near(1))
        .transact();
    let c2 = w
        .agent
        .call(w.policy.id(), "reserve")
        .args_json(action(&w.user, "60", 2))
        .deposit(NearToken::from_near(1))
        .transact();
    let (r1, r2) = tokio::join!(c1, c2);
    let wins = [r1?.is_success(), r2?.is_success()]
        .into_iter()
        .filter(|s| *s)
        .count();
    assert_eq!(wins, 1, "exactly one competing reservation may succeed");
    assert_eq!(budget(&w).await?["reserved"], "60");
    Ok(())
}

#[tokio::test]
async fn idempotent_and_conflicting_requests_are_handled() -> anyhow::Result<()> {
    let w = deploy().await?;
    create_grant(&w, "100", FUTURE_NS).await?;
    for _ in 0..2 {
        w.agent
            .call(w.policy.id(), "reserve")
            .args_json(action(&w.user, "60", 1))
            .deposit(NearToken::from_near(1))
            .transact()
            .await?
            .into_result()?; // same request twice: idempotent
    }
    assert_eq!(budget(&w).await?["reserved"], "60"); // charged once
                                                     // Same request id, different amount: rejected without changing counters.
    let conflict = w
        .agent
        .call(w.policy.id(), "reserve")
        .args_json(action(&w.user, "70", 1))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    assert!(conflict.is_failure());
    assert_eq!(budget(&w).await?["reserved"], "60");
    Ok(())
}

#[tokio::test]
async fn infrastructure_caller_cannot_reserve() -> anyhow::Result<()> {
    let w = deploy().await?;
    create_grant(&w, "100", FUTURE_NS).await?;
    let auditor = w.worker.dev_create_account().await?;
    // A non-delegate, non-user caller (an infrastructure role) cannot originate a reservation.
    let r = auditor
        .call(w.policy.id(), "reserve")
        .args_json(action(&w.user, "10", 1))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    assert!(r.is_failure());
    assert!(
        w.policy
            .view("get_budget")
            .args_json(json!({"user": w.user.id(), "local_id": b32(7)}))
            .await?
            .json::<Value>()?["reserved"]
            == "0"
    );
    Ok(())
}

#[tokio::test]
async fn revocation_and_expiry_block_new_reservations() -> anyhow::Result<()> {
    let w = deploy().await?;
    create_grant(&w, "100", FUTURE_NS).await?;
    w.user
        .call(w.policy.id(), "revoke_grant")
        .args_json(json!({"local_id": b32(7)}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let revoked = w
        .agent
        .call(w.policy.id(), "reserve")
        .args_json(action(&w.user, "10", 1))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    assert!(revoked.is_failure());

    // A separate grant that is already expired also refuses new reservations.
    let w2 = deploy().await?;
    create_grant(&w2, "100", "1").await?;
    let expired = w2
        .agent
        .call(w2.policy.id(), "reserve")
        .args_json(action(&w2.user, "10", 1))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    assert!(expired.is_failure());
    Ok(())
}

#[tokio::test]
async fn the_normal_build_exposes_no_fixture_outcome_authority() -> anyhow::Result<()> {
    let w = deploy().await?;
    create_grant(&w, "100", FUTURE_NS).await?;
    w.agent
        .call(w.policy.id(), "reserve")
        .args_json(action(&w.user, "60", 1))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    // No fixture confirmation/unlock path exists in the deployed build.
    for method in ["fixture_release_not_executed", "set_executor"] {
        let r = w
            .agent
            .call(w.policy.id(), method)
            .args_json(json!({"user": w.user.id(), "local_id": b32(7), "request_id": b32(1)}))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?;
        assert!(
            r.is_failure(),
            "{method} must not exist in the normal build"
        );
    }
    assert_eq!(budget(&w).await?["reserved"], "60"); // budget untouched by the attempts
    Ok(())
}

#[tokio::test]
async fn insufficient_storage_deposit_is_rejected() -> anyhow::Result<()> {
    let w = deploy().await?;
    let r = w
        .user
        .call(w.policy.id(), "create_grant")
        .args_json(grant_input(&w.agent, "100", FUTURE_NS))
        .deposit(NearToken::from_yoctonear(1)) // far below the storage cost
        .transact()
        .await?;
    assert!(r.is_failure());
    // Nothing was stored, so no grant exists.
    let g: Option<Value> = w
        .policy
        .view("get_grant")
        .args_json(json!({"user": w.user.id(), "local_id": b32(7)}))
        .await?
        .json()?;
    assert!(g.is_none());
    Ok(())
}

#[tokio::test]
async fn replacement_rejections_preserve_asset_budget_and_grant_version() -> anyhow::Result<()> {
    let w = deploy().await?;
    create_grant(&w, "100", FUTURE_NS).await?;
    w.agent
        .call(w.policy.id(), "reserve")
        .args_json(action(&w.user, "80", 1))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let before_budget = budget(&w).await?;
    let mut replacement = grant_input(&w.agent, "100", FUTURE_NS);
    replacement["input"]["version"] = json!("2");
    let mut too_small = replacement.clone();
    too_small["input"]["per_action_cap"] = json!("50");
    too_small["input"]["cumulative_cap"] = json!("50");
    let mut invalid_replacements = vec![too_small];
    for (field, value) in [
        ("chain_id", json!("1")),
        ("token", json!("0x00000000000000000000000000000000000000bb")),
        ("representation", json!("other-token.testnet")),
        ("custody_domain", json!("vault-2")),
        ("mapping_version", json!("3")),
    ] {
        let mut changed_asset = replacement.clone();
        changed_asset["input"]["asset"][field] = value;
        invalid_replacements.push(changed_asset);
    }
    for invalid in invalid_replacements {
        let outcome = w
            .user
            .call(w.policy.id(), "create_grant")
            .args_json(invalid)
            .deposit(NearToken::from_near(1))
            .transact()
            .await?;
        assert!(outcome.is_failure());
        assert_eq!(budget(&w).await?, before_budget);
        let grant: Value = w
            .policy
            .view("get_grant")
            .args_json(json!({"user": w.user.id(), "local_id": b32(7)}))
            .await?
            .json()?;
        assert_eq!(grant["version"], "1");
    }
    // An exact-use cap and differently cased spelling of the same token remain valid.
    replacement["input"]["per_action_cap"] = json!("80");
    replacement["input"]["cumulative_cap"] = json!("80");
    replacement["input"]["asset"]["token"] = json!("0x00000000000000000000000000000000000000AA");
    w.user
        .call(w.policy.id(), "create_grant")
        .args_json(replacement)
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let after = budget(&w).await?;
    assert_eq!(after["authorized_limit"], "80");
    assert_eq!(after["reserved"], "80");
    assert_eq!(after["available"], "0");
    Ok(())
}

async fn reserve_ok(w: &World, amount: &str, request: u8) -> anyhow::Result<()> {
    w.agent
        .call(w.policy.id(), "reserve")
        .args_json(action(&w.user, amount, request))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

fn reservation_args(w: &World, request: u8) -> Value {
    json!({"user": w.user.id(), "local_id": b32(7), "request_id": b32(request)})
}

async fn reservation_state(w: &World, request: u8) -> anyhow::Result<String> {
    let v: Value = w
        .policy
        .view("get_reservation")
        .args_json(reservation_args(w, request))
        .await?
        .json()?;
    Ok(v["state"].as_str().unwrap_or_default().to_string())
}

#[tokio::test]
async fn a_delegate_equal_to_the_user_is_rejected() -> anyhow::Result<()> {
    let w = deploy().await?;
    let r = w
        .user
        .call(w.policy.id(), "create_grant")
        .args_json(grant_input(&w.user, "100", FUTURE_NS))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    assert!(r.into_result().is_err());
    let g: Option<Value> = w
        .policy
        .view("get_grant")
        .args_json(json!({"user": w.user.id(), "local_id": b32(7)}))
        .await?
        .json()?;
    assert!(g.is_none());
    Ok(())
}

#[tokio::test]
async fn revocation_is_permanent_and_a_version_bump_cannot_undo_it() -> anyhow::Result<()> {
    let w = deploy().await?;
    create_grant(&w, "100", FUTURE_NS).await?;
    w.user
        .call(w.policy.id(), "revoke_grant")
        .args_json(json!({"local_id": b32(7)}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let mut bumped = grant_input(&w.agent, "100", FUTURE_NS);
    bumped["input"]["version"] = json!("2");
    let r = w
        .user
        .call(w.policy.id(), "create_grant")
        .args_json(bumped)
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    assert!(r.into_result().is_err());
    let g: Value = w
        .policy
        .view("get_grant")
        .args_json(json!({"user": w.user.id(), "local_id": b32(7)}))
        .await?
        .json()?;
    assert_eq!(
        (g["revoked"].as_bool(), g["version"].as_str()),
        (Some(true), Some("1"))
    );
    assert!(w
        .agent
        .call(w.policy.id(), "reserve")
        .args_json(action(&w.user, "10", 1))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()
        .is_err());
    // A new local id is a fresh grant with its own budget.
    let mut fresh = grant_input(&w.agent, "100", FUTURE_NS);
    fresh["input"]["local_id"] = json!(b32(8));
    w.user
        .call(w.policy.id(), "create_grant")
        .args_json(fresh)
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

#[tokio::test]
async fn undispatched_reservation_is_cancelled_by_user_or_delegate_only() -> anyhow::Result<()> {
    let w = deploy().await?;
    create_grant(&w, "100", FUTURE_NS).await?;
    reserve_ok(&w, "60", 1).await?;
    let auditor = w.worker.dev_create_account().await?;
    for caller in [&auditor, &w.owner] {
        let r = caller
            .call(w.policy.id(), "cancel_reservation")
            .args_json(reservation_args(&w, 1))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?;
        assert!(r.into_result().is_err(), "infrastructure must not cancel");
    }
    assert_eq!(budget(&w).await?["reserved"], "60");
    // Exactly one yocto is required.
    let no_deposit = w
        .agent
        .call(w.policy.id(), "cancel_reservation")
        .args_json(reservation_args(&w, 1))
        .transact()
        .await?;
    assert!(no_deposit.into_result().is_err());
    w.agent
        .call(w.policy.id(), "cancel_reservation")
        .args_json(reservation_args(&w, 1))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(reservation_state(&w, 1).await?, "released");
    let b = budget(&w).await?;
    assert_eq!(
        (b["reserved"].as_str(), b["available"].as_str()),
        (Some("0"), Some("100"))
    );
    // The released request id cannot be reserved again; a new one can.
    assert!(w
        .agent
        .call(w.policy.id(), "reserve")
        .args_json(action(&w.user, "60", 1))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()
        .is_err());
    reserve_ok(&w, "60", 2).await?;
    // The user may cancel after revoking the grant.
    w.user
        .call(w.policy.id(), "revoke_grant")
        .args_json(json!({"local_id": b32(7)}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(budget(&w).await?["reserved"], "60"); // revocation alone releases nothing
    w.user
        .call(w.policy.id(), "cancel_reservation")
        .args_json(reservation_args(&w, 2))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(budget(&w).await?["reserved"], "0");
    Ok(())
}

#[tokio::test]
async fn reservations_expire_and_anyone_can_release_them_after_the_configured_ttl(
) -> anyhow::Result<()> {
    let w = deploy().await?;
    // The owner shortens the lifetime of new reservations to the 60 second minimum.
    w.owner
        .call(w.policy.id(), "set_reservation_ttl")
        .args_json(json!({"ttl_ns": "60000000000"}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let stranger = w.worker.dev_create_account().await?;
    assert!(stranger
        .call(w.policy.id(), "set_reservation_ttl")
        .args_json(json!({"ttl_ns": "60000000000"}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()
        .is_err());
    create_grant(&w, "100", FUTURE_NS).await?;
    reserve_ok(&w, "60", 1).await?;
    let release = |who: &Account| {
        who.call(w.policy.id(), "release_expired")
            .args_json(reservation_args(&w, 1))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
    };
    assert!(
        release(&stranger).await?.into_result().is_err(),
        "not expired yet"
    );
    assert_eq!(budget(&w).await?["reserved"], "60");
    w.worker.fast_forward(200).await?;
    release(&stranger).await?.into_result()?;
    assert_eq!(reservation_state(&w, 1).await?, "released");
    assert_eq!(budget(&w).await?["available"], "100");
    release(&stranger).await?.into_result()?; // idempotent
    assert_eq!(budget(&w).await?["available"], "100");
    Ok(())
}

#[tokio::test]
async fn two_users_with_the_same_local_ids_stay_separately_attributed() -> anyhow::Result<()> {
    let w = deploy().await?;
    create_grant(&w, "100", FUTURE_NS).await?;
    let user2 = w.worker.dev_create_account().await?;
    let agent2 = w.worker.dev_create_account().await?;
    user2
        .call(w.policy.id(), "create_grant")
        .args_json(grant_input(&agent2, "100", FUTURE_NS))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    reserve_ok(&w, "70", 1).await?;
    agent2
        .call(w.policy.id(), "reserve")
        .args_json(action(&user2, "90", 1)) // same local grant id and request id
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    // Each delegate can act only for its own user.
    assert!(agent2
        .call(w.policy.id(), "reserve")
        .args_json(action(&w.user, "5", 9))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()
        .is_err());
    let b2: Value = w
        .policy
        .view("get_budget")
        .args_json(json!({"user": user2.id(), "local_id": b32(7)}))
        .await?
        .json()?;
    assert_eq!(budget(&w).await?["reserved"], "70");
    assert_eq!(b2["reserved"], "90");
    // Cancelling one user's reservation leaves the other untouched.
    w.agent
        .call(w.policy.id(), "cancel_reservation")
        .args_json(reservation_args(&w, 1))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let b2: Value = w
        .policy
        .view("get_budget")
        .args_json(json!({"user": user2.id(), "local_id": b32(7)}))
        .await?
        .json()?;
    assert_eq!(budget(&w).await?["reserved"], "0");
    assert_eq!(b2["reserved"], "90");
    Ok(())
}

#[tokio::test]
async fn unknown_action_fields_fail_without_reserving_budget() -> anyhow::Result<()> {
    let w = deploy().await?;
    create_grant(&w, "100", FUTURE_NS).await?;
    let mut uncommitted_payload = action(&w.user, "10", 1);
    uncommitted_payload["action"]["calldata"] = json!("ignored executable payload");
    let result = w
        .agent
        .call(w.policy.id(), "reserve")
        .args_json(uncommitted_payload)
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    assert!(result.is_failure());
    assert_eq!(budget(&w).await?["reserved"], "0");
    Ok(())
}

/// A separate target directory keeps fixture authority out of the normal artifact tested above.
fn fixture_player_policy_wasm() -> anyhow::Result<Vec<u8>> {
    let workspace = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace")
        .to_path_buf();
    let target = workspace.join("target/player-policy-fixtures");
    let status = std::process::Command::new("cargo")
        .current_dir(&workspace)
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "-p",
            "valtrum-player-policy",
            "--features",
            "sandbox-fixtures",
            "--target-dir",
        ])
        .arg(&target)
        .status()?;
    anyhow::ensure!(status.success(), "player-policy fixture wasm build failed");
    Ok(std::fs::read(target.join(
        "wasm32-unknown-unknown/release/valtrum_player_policy.wasm",
    ))?)
}

/// Receipt evidence flow in the NORMAL build against the real receipt registry. Claims are
/// synthetic verifier assertions, not live finality, and no funds move.
#[tokio::test]
async fn only_finalized_registry_receipt_evidence_consumes_a_dispatched_obligation(
) -> anyhow::Result<()> {
    let w = deploy().await?;
    create_grant(&w, "100", FUTURE_NS).await?;
    reserve_ok(&w, "60", 1).await?;
    reserve_ok(&w, "40", 2).await?;
    // No role but the user or the delegate can admit an action for execution.
    for caller in [&w.owner, &w.verifier] {
        let r = caller
            .call(w.policy.id(), "dispatch")
            .args_json(reservation_args(&w, 1))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?;
        assert!(r.into_result().is_err(), "infrastructure cannot dispatch");
    }
    for request in [1, 2] {
        w.agent
            .call(w.policy.id(), "dispatch")
            .args_json(reservation_args(&w, request))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .into_result()?;
    }
    // The evidence is the registry claim, so anyone may submit it and no role can fake it.
    let stranger = w.worker.dev_create_account().await?;
    // Unknown receipt: nothing is consumed.
    assert!(!confirm(&w, &stranger, 1, 9).await?.json::<bool>()?);
    assert_eq!(budget(&w).await?["consumed"], "0");
    // A finalized claim for another amount does not bind.
    attest(&w, 9, "59").await?.into_result()?;
    assert!(!confirm(&w, &stranger, 1, 9).await?.json::<bool>()?);
    assert_eq!(reservation_state(&w, 1).await?, "dispatched");
    // The exact claim binds.
    attest(&w, 8, "60").await?.into_result()?;
    assert!(confirm(&w, &stranger, 1, 8).await?.json::<bool>()?);
    let b = budget(&w).await?;
    assert_eq!(
        (b["consumed"].as_str(), b["reserved"].as_str()),
        (Some("60"), Some("40"))
    );
    assert_eq!(reservation_state(&w, 1).await?, "consumed");
    // The same receipt cannot settle a second reservation.
    let replay = confirm(&w, &stranger, 2, 8).await?;
    assert!(replay.into_result().is_err());
    // A disputed claim no longer counts as evidence.
    attest(&w, 7, "40").await?.into_result()?;
    w.verifier
        .call(w.registry.id(), "dispute")
        .args_json(json!({"key": {"chain_id": "46630", "transaction_hash": vec![7u8; 32], "log_index": 0}}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    assert!(!confirm(&w, &stranger, 2, 7).await?.json::<bool>()?);
    assert_eq!(reservation_state(&w, 2).await?, "dispatched");
    assert_eq!(budget(&w).await?["reserved"], "40");
    Ok(())
}

async fn confirm(
    w: &World,
    who: &Account,
    request: u8,
    hash: u8,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    let mut args = reservation_args(w, request);
    args["receipt"] = json!({"transaction_hash": vec![hash; 32], "log_index": 0});
    Ok(who
        .call(w.policy.id(), "confirm_with_receipt")
        .args_json(args)
        .deposit(NearToken::from_millinear(10))
        .max_gas()
        .transact()
        .await?)
}

async fn attest(
    w: &World,
    hash: u8,
    amount: &str,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    let key = json!({"chain_id": "46630", "transaction_hash": vec![hash; 32], "log_index": 0});
    let claim = json!({
        "representation": "aa.token.testnet",
        "token_address": TOKEN,
        "custody_domain": "vault-1",
        "mapping_version": "2",
        "beneficiary": w.user.id(),
        "refund_address": vec![0xbeu8; 20],
        "battle_id": "5",
        "actual_received": amount,
        "block_number": "3",
        "block_hash": vec![2u8; 32],
        "finalized_head_number": "4",
        "finalized_head_hash": vec![3u8; 32],
        "evidence_hash": vec![4u8; 32],
    });
    Ok(w.verifier
        .call(w.registry.id(), "attest")
        .args_json(json!({"key": key, "claim": claim}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?)
}

/// Runs in the existing sandbox CI job without enabling fixture methods in the normal build.
/// Synthetic execution outcomes are not evidence of real player spending or foreign finality.
#[tokio::test]
async fn revocation_blocks_queued_admission_but_preserves_dispatched_obligations(
) -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let policy = worker.dev_deploy(&fixture_player_policy_wasm()?).await?;
    let owner = worker.dev_create_account().await?;
    let executor = worker.dev_create_account().await?;
    let user = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    policy
        .call("new")
        .args_json(json!({"owner": owner.id(), "registry": "registry.testnet"}))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(policy.id(), "set_executor")
        .args_json(json!({"executor": executor.id()}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    user.call(policy.id(), "create_grant")
        .args_json(grant_input(&agent, "100", FUTURE_NS))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    for (amount, request) in [("40", 1), ("60", 2)] {
        agent
            .call(policy.id(), "reserve")
            .args_json(action(&user, amount, request))
            .deposit(NearToken::from_near(1))
            .transact()
            .await?
            .into_result()?;
    }
    let queued = json!({"user": user.id(), "local_id": b32(7), "request_id": b32(1)});
    let dispatched = json!({"user": user.id(), "local_id": b32(7), "request_id": b32(2)});
    agent
        .call(policy.id(), "dispatch")
        .args_json(dispatched.clone())
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    user.call(policy.id(), "revoke_grant")
        .args_json(json!({"local_id": b32(7)}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    // Revocation is permanent per grant id: a version bump cannot re-enable the grant.
    let mut replacement = grant_input(&agent, "100", FUTURE_NS);
    replacement["input"]["version"] = json!("2");
    replacement["input"]["destinations"] = json!(["0x0000000000000000000000000000000000000099"]);
    let bump = user
        .call(policy.id(), "create_grant")
        .args_json(replacement)
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    assert!(bump.into_result().is_err(), "a revoked grant stays revoked");
    let stale_dispatch = agent
        .call(policy.id(), "dispatch")
        .args_json(queued.clone())
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    // The raw `cargo build` wasm used by these sandbox tests reports every contract panic as a
    // WebAssembly `unreachable` trap, so the panic text is not observable here. The reason
    // ("Grant revoked") is asserted by the unit tests; this test checks the outcome: the call
    // fails and the queued v1 reservation is left untouched.
    assert!(
        stale_dispatch.into_result().is_err(),
        "a revoked grant must not admit the queued action"
    );
    let queued_state: Value = policy
        .view("get_reservation")
        .args_json(queued.clone())
        .await?
        .json()?;
    assert_eq!(queued_state["state"], "reserved");
    // The dispatched obligation cannot be cancelled by the user or the delegate.
    for caller in [&user, &agent] {
        let cancel = caller
            .call(policy.id(), "cancel_reservation")
            .args_json(dispatched.clone())
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?;
        assert!(
            cancel.into_result().is_err(),
            "dispatched must not be cancelled"
        );
    }
    // The never-dispatched reservation can be cancelled after revocation, restoring its budget.
    user.call(policy.id(), "cancel_reservation")
        .args_json(queued)
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    // Revocation still allows flagging the already dispatched action (idempotent).
    for _ in 0..2 {
        agent
            .call(policy.id(), "mark_reconciliation")
            .args_json(dispatched.clone())
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .into_result()?;
    }
    // Only the fixture-only executor adapter can release it (synthetic no-execution proof);
    // the delegate cannot.
    let by_delegate = agent
        .call(policy.id(), "fixture_release_not_executed")
        .args_json(dispatched.clone())
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(by_delegate.into_result().is_err());
    executor
        .call(policy.id(), "fixture_release_not_executed")
        .args_json(dispatched)
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let budget: Value = policy
        .view("get_budget")
        .args_json(json!({"user": user.id(), "local_id": b32(7)}))
        .await?
        .json()?;
    assert_eq!(budget["consumed"], "0");
    assert_eq!(budget["reserved"], "0");
    assert_eq!(budget["authorized_limit"], "100");
    Ok(())
}
