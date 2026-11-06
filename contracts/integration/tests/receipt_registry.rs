mod common;

use near_workspaces::types::NearToken;
use serde_json::json;

/// Registry claims below are synthetic verifier assertions, not live finality.
#[tokio::test]
async fn registry_rejects_cross_representation_replay_and_retains_disputes() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let registry = worker
        .dev_deploy(&common::wasm("valtrum_receipt_registry"))
        .await?;
    let owner = worker.dev_create_account().await?;
    let verifier = worker.dev_create_account().await?;
    let first = worker.dev_create_account().await?;
    let second = worker.dev_create_account().await?;
    registry
        .call("new")
        .args_json(json!({"owner": owner.id(), "verifier": verifier.id()}))
        .transact()
        .await?
        .into_result()?;
    for representation in [first.id(), second.id()] {
        owner
            .call(registry.id(), "set_representation")
            .args_json(json!({"representation": representation, "allowed": true}))
            .deposit(NearToken::from_near(1))
            .transact()
            .await?
            .into_result()?;
    }
    let key = json!({"chain_id": "46630", "transaction_hash": vec![1u8;32], "log_index": 1});
    let mut claim = json!({"representation": first.id(), "token_address": "0x0000000000000000000000000000000000000001", "custody_domain": "fixture", "mapping_version": "1", "beneficiary": first.id(), "battle_id": "1", "actual_received": "98", "block_number": "3", "block_hash": vec![2u8;32], "finalized_head_number": "4", "finalized_head_hash": vec![3u8;32], "evidence_hash": vec![4u8;32]});
    let args = json!({"key": key, "claim": claim});
    let attack = first
        .call(registry.id(), "attest")
        .args_json(args.clone())
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    assert!(attack.into_result().is_err());
    verifier
        .call(registry.id(), "attest")
        .args_json(args.clone())
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    verifier
        .call(registry.id(), "attest")
        .args_json(args)
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    claim["representation"] = json!(second.id());
    let replay = verifier
        .call(registry.id(), "attest")
        .args_json(json!({"key":key, "claim":claim}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    assert!(replay.into_result().is_err());
    verifier
        .call(registry.id(), "dispute")
        .args_json(json!({"key":key}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let active: Option<serde_json::Value> = registry
        .view("get_active_claim")
        .args_json(json!({"key":key}))
        .await?
        .json()?;
    let recorded: Option<serde_json::Value> = registry
        .view("get_claim")
        .args_json(json!({"key":key}))
        .await?
        .json()?;
    assert!(active.is_none());
    assert_eq!(recorded.unwrap()["representation"], first.id().as_str());
    Ok(())
}
