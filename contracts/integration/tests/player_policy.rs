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
        "chain_id": "4663",
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
        "battle": null,
    }})
}

struct World {
    worker: near_workspaces::Worker<near_workspaces::network::Sandbox>,
    policy: Contract,
    user: Account,
    agent: Account,
}

async fn deploy() -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let policy = worker
        .dev_deploy(&common::wasm("valtrum_player_policy"))
        .await?;
    let owner = worker.dev_create_account().await?;
    policy
        .call("new")
        .args_json(json!({"owner": owner.id()}))
        .transact()
        .await?
        .into_result()?;
    let user = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    Ok(World {
        worker,
        policy,
        user,
        agent,
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
    for method in [
        "fixture_consume",
        "fixture_release",
        "fixture_dispatch",
        "set_executor",
    ] {
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
