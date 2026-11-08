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
    let mut claim = json!({"representation": first.id(), "token_address": "0x0000000000000000000000000000000000000001", "custody_domain": "fixture", "mapping_version": "1", "beneficiary": first.id(), "refund_address": vec![0xbeu8; 20], "battle_id": "1", "actual_received": "98", "block_number": "3", "block_hash": vec![2u8;32], "finalized_head_number": "4", "finalized_head_hash": vec![3u8;32], "evidence_hash": vec![4u8;32]});
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

/// The attestation below is a synthetic operator assertion, not live finality.
#[tokio::test]
async fn backing_credits_registry_claim_once_and_only_to_the_attested_beneficiary(
) -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let registry = worker
        .dev_deploy(&common::wasm("valtrum_receipt_registry"))
        .await?;
    let backing = worker.dev_deploy(&common::wasm("valtrum_backing")).await?;
    let owner = worker.dev_create_account().await?;
    let verifier = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let relayer = worker.dev_create_account().await?;
    // Sandbox stand-in for the arena's lock view; battle 1 is open.
    let arena = worker
        .dev_deploy(&common::wasm("valtrum_mock_lifecycle"))
        .await?;
    arena.call("new").transact().await?.into_result()?;
    arena
        .call("set_battle")
        .args_json(json!({"battle_id": "1", "locked": false}))
        .transact()
        .await?
        .into_result()?;
    registry
        .call("new")
        .args_json(json!({"owner": owner.id(), "verifier": verifier.id()}))
        .transact()
        .await?
        .into_result()?;
    backing.call("new").args_json(json!({
        "owner": owner.id(),
        "asset": { "chain_id": "46630", "token_address": "0x0000000000000000000000000000000000000001", "custody_domain": "fixture", "source_decimals": 18, "representation_decimals": 18 },
        "name": "Representation fixture", "symbol": "TEST",
        "registry": registry.id(), "mapping_version": "1", "arena": arena.id(), "payout": owner.id()
    })).max_gas().transact().await?.into_result()?;
    owner
        .call(registry.id(), "set_representation")
        .args_json(json!({"representation": backing.id(), "allowed": true}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let tx = format!("0x{}", "01".repeat(32));
    let args = |log_index: u32| json!({"transaction_hash": tx, "log_index": log_index});
    // No attestation yet: nothing is credited and the deposit comes back.
    let missing = relayer
        .call(backing.id(), "claim_receipt")
        .args_json(args(1))
        .deposit(NearToken::from_millinear(20))
        .max_gas()
        .transact()
        .await?;
    assert!(!missing.into_result()?.json::<bool>()?);
    let key = json!({"chain_id": "46630", "transaction_hash": vec![1u8;32], "log_index": 1});
    let claim = json!({"representation": backing.id(), "token_address": "0x0000000000000000000000000000000000000001", "custody_domain": "fixture", "mapping_version": "1", "beneficiary": alice.id(), "refund_address": vec![0xbeu8; 20], "battle_id": "1", "actual_received": "98", "block_number": "3", "block_hash": vec![2u8;32], "finalized_head_number": "4", "finalized_head_hash": vec![3u8;32], "evidence_hash": vec![4u8;32]});
    verifier
        .call(registry.id(), "attest")
        .args_json(json!({"key": key, "claim": claim}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let first = relayer
        .call(backing.id(), "claim_receipt")
        .args_json(args(1))
        .deposit(NearToken::from_millinear(20))
        .max_gas()
        .transact()
        .await?;
    assert!(first.into_result()?.json::<bool>()?);
    let replay = relayer
        .call(backing.id(), "claim_receipt")
        .args_json(args(1))
        .deposit(NearToken::from_millinear(20))
        .max_gas()
        .transact()
        .await?;
    assert!(!replay.into_result()?.json::<bool>()?);
    let held: String = backing
        .view("unallocated_balance_of")
        .args_json(json!({"account": alice.id()}))
        .await?
        .json()?;
    assert_eq!(held, "98");
    let relayer_held: String = backing
        .view("unallocated_balance_of")
        .args_json(json!({"account": relayer.id()}))
        .await?
        .json()?;
    assert_eq!(relayer_held, "0");
    let supply: String = backing
        .view("ft_total_supply")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(supply, "0");
    // A registry dispute pauses the asset but keeps the attributed liability.
    let not_yet = relayer
        .call(backing.id(), "report_registry_dispute")
        .args_json(args(1))
        .max_gas()
        .transact()
        .await?;
    assert!(!not_yet.into_result()?.json::<bool>()?);
    verifier
        .call(registry.id(), "dispute")
        .args_json(json!({"key": key}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let paused = relayer
        .call(backing.id(), "report_registry_dispute")
        .args_json(args(1))
        .max_gas()
        .transact()
        .await?;
    assert!(paused.into_result()?.json::<bool>()?);
    let ledger: serde_json::Value = backing
        .view("get_ledger")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(ledger["paused"], true);
    assert_eq!(ledger["reconciliation_required"], true);
    assert_eq!(ledger["unallocated"], "98");
    Ok(())
}
