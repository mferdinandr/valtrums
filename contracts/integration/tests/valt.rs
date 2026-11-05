//! VALT in the sandbox: an atomic launch that leaves the contract without keys,
//! a day that meets the muster target, a missed day that burns, and the lock.

mod common;

use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const DAY_SECS: u64 = 60;
const MIN: u128 = 100;

async fn state(valt: &Contract) -> anyhow::Result<Value> {
    Ok(valt.view("get_state").await?.json()?)
}

async fn balance(valt: &Contract, who: &Account) -> anyhow::Result<u128> {
    let b: String = valt
        .view("ft_balance_of")
        .args_json(json!({ "account_id": who.id() }))
        .await?
        .json()?;
    Ok(b.parse()?)
}

/// Produces blocks until the contract reports a later day.
async fn next_day(worker: &Worker<Sandbox>, valt: &Contract) -> anyhow::Result<u64> {
    let start = state(valt).await?["day"].as_u64().unwrap_or(0);
    for _ in 0..200 {
        worker.fast_forward(5).await?;
        let day = state(valt).await?["day"].as_u64().unwrap_or(0);
        if day > start {
            return Ok(day);
        }
    }
    anyhow::bail!("the day did not advance")
}

#[tokio::test]
async fn valt_ritual_runs_with_no_key_on_the_contract() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let mut players = Vec::new();
    for name in ["alice", "bob", "carol"] {
        players.push(
            root.create_subaccount(name)
                .initial_balance(NearToken::from_near(10))
                .transact()
                .await?
                .into_result()?,
        );
    }
    let valt_account = root
        .create_subaccount("valt")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;

    // Launch in one transaction: deploy, initialise, delete the only key.
    let config = json!({
        "name": "Valtrum War Drum",
        "symbol": "VALT",
        "decimals": 18,
        "icon": null,
        "war_chest": "10000",
        "allocations": players
            .iter()
            .map(|p| json!({ "account_id": p.id(), "amount": "1000" }))
            .collect::<Vec<_>>(),
        "day_length_secs": DAY_SECS.to_string(),
        "muster_target": 3,
        "mint_per_muster": "10",
        "burn_bps": 1000,
        "min_balance": MIN.to_string(),
        "max_supply": "1000000",
    });
    valt_account
        .batch(valt_account.id())
        .deploy(&common::wasm("valtrum_valt"))
        .call(Function::new("new").args_json(json!({ "config": config })))
        .delete_key(valt_account.secret_key().public_key())
        .transact()
        .await?
        .into_result()?;
    let keys = worker.view_access_keys(valt_account.id()).await?;
    assert!(keys.is_empty(), "the contract account must have no keys");
    let valt = Contract::from_secret_key(
        valt_account.id().clone(),
        valt_account.secret_key().clone(),
        &worker,
    );

    let params: Value = valt.view("get_params").await?.json()?;
    assert_eq!(params["muster_target"], 3);
    assert_eq!(params["burn_bps"], 1000);
    assert_eq!(params["day_length_secs"], DAY_SECS.to_string());

    // Today: everyone musters, so the day counts.
    for p in &players {
        p.call(valt.id(), "muster")
            .transact()
            .await?
            .into_result()?;
    }
    assert_eq!(state(&valt).await?["today_musters"], 3);

    // The lock: alice cannot move her minimum out today.
    let moved = players[0]
        .call(valt.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": players[1].id(), "amount": "901" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(
        moved.is_failure(),
        "a musterer must keep the minimum balance"
    );

    // Next day: alice's muster also mints her reward for the day before.
    next_day(&worker, &valt).await?;
    let projected = state(&valt).await?;
    assert_eq!(projected["streak"], 1);
    players[0]
        .call(valt.id(), "muster")
        .transact()
        .await?
        .into_result()?;
    assert_eq!(balance(&valt, &players[0]).await?, 1_010);
    players[1]
        .call(valt.id(), "claim_reward")
        .args_json(json!({ "account_id": players[1].id() }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(balance(&valt, &players[1]).await?, 1_010);

    // Only one muster this day: when it ends, 10% of the chest burns.
    next_day(&worker, &valt).await?;
    let closed = players[2]
        .call(valt.id(), "close_days")
        .transact()
        .await?
        .into_result()?;
    let burns: Vec<String> = closed
        .logs()
        .iter()
        .filter(|l| l.contains("\"ft_burn\""))
        .map(|l| l.to_string())
        .collect();
    assert_eq!(burns.len(), 1, "one burn event for the missed day");
    let s = state(&valt).await?;
    assert_eq!(s["streak"], 0);
    assert_eq!(s["longest_streak"], 1);
    assert_eq!(s["war_chest"], "9000");
    assert_eq!(s["total_burned"], "1000");

    let log: Vec<Value> = valt
        .view("get_log")
        .args_json(json!({ "from_index": 0, "limit": 10 }))
        .await?
        .json()?;
    assert_eq!(log.len(), 2);
    assert_eq!(log[0]["target_met"], true);
    assert_eq!(log[1]["target_met"], false);
    assert_eq!(log[1]["burned"], "1000");

    // Supply: 13000 at launch + 20 claimed rewards - 1000 burned.
    let supply: String = valt.view("ft_total_supply").await?.json()?;
    assert_eq!(supply, "12020");
    Ok(())
}
