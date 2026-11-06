mod common;

use near_workspaces::types::NearToken;
use serde_json::json;

#[tokio::test]
async fn unverified_receipts_and_internal_reservations_are_not_contract_api() -> anyhow::Result<()>
{
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&common::wasm("valtrum_backing")).await?;
    let owner = worker.dev_create_account().await?;
    let attacker = worker.dev_create_account().await?;
    contract.call("new").args_json(json!({
        "owner": owner.id(),
        "asset": { "chain_id": "46630", "token_address": "0x0000000000000000000000000000000000000001", "custody_domain": "fixture", "source_decimals": 18, "representation_decimals": 18 },
        "name": "Representation fixture", "symbol": "TEST", "registry": owner.id(), "mapping_version": "1", "arena": owner.id()
    })).max_gas().transact().await?.into_result()?;
    for method in [
        "observe_receipt",
        "finalize_receipt",
        "reorganize_receipt",
        "reserve_representation",
        "record_reservation_broadcast",
        "confirm_redemption",
        "fixture_observe",
        "fixture_finalize",
        "fixture_reorganize",
        "fixture_reserve",
        "fixture_broadcast",
    ] {
        let attempted = attacker
            .call(contract.id(), method)
            .args_json(json!({}))
            .max_gas()
            .transact()
            .await?;
        assert!(
            attempted.into_result().is_err(),
            "internal method {method} was callable"
        );
    }
    let claim = attacker
        .call(contract.id(), "claim_representation")
        .args_json(json!({"beneficiary": attacker.id(), "amount": "98"}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(claim.into_result().is_err());
    let supply: String = contract
        .view("ft_total_supply")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(supply, "0");
    let ledger: serde_json::Value = contract
        .view("get_ledger")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(ledger["custody"], "0");
    assert_eq!(ledger["accounting_balanced"], true);
    Ok(())
}

fn fixture_backing_wasm() -> anyhow::Result<Vec<u8>> {
    let workspace = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace")
        .to_path_buf();
    let target = workspace.join("target/backing-fixtures");
    let status = std::process::Command::new("cargo")
        .current_dir(&workspace)
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "-p",
            "valtrum-backing",
            "--features",
            "sandbox-fixtures",
            "--target-dir",
        ])
        .arg(&target)
        .status()?;
    anyhow::ensure!(status.success(), "fixture wasm build failed");
    Ok(std::fs::read(target.join(
        "wasm32-unknown-unknown/release/valtrum_backing.wasm",
    ))?)
}

/// Synthetic receipt and finality; does not verify Robinhood custody.
#[tokio::test]
async fn fixture_receipt_mint_reservations_and_reorg_preserve_liabilities() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&fixture_backing_wasm()?).await?;
    let owner = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    contract.call("new").args_json(json!({
        "owner": owner.id(),
        "asset": { "chain_id": "46630", "token_address": "0x0000000000000000000000000000000000000001", "custody_domain": "fixture", "source_decimals": 18, "representation_decimals": 18 },
        "name": "Representation fixture", "symbol": "TEST", "registry": owner.id(), "mapping_version": "1", "arena": owner.id()
    })).max_gas().transact().await?.into_result()?;
    let hash = format!("0x{}", "ab".repeat(32));
    let upper_hash = format!("0X{}", "AB".repeat(32));
    let args = json!({"hash": hash, "log_index": 1, "beneficiary": alice.id(), "amount": "98"});
    let unauthorized = alice
        .call(contract.id(), "fixture_observe")
        .args_json(args.clone())
        .max_gas()
        .transact()
        .await?;
    assert!(unauthorized.into_result().is_err());
    contract
        .call("fixture_observe")
        .args_json(args)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    contract
        .call("fixture_observe")
        .args_json(
            json!({"hash": upper_hash, "log_index": 1, "beneficiary": alice.id(), "amount": "98"}),
        )
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    for _ in 0..2 {
        contract
            .call("fixture_finalize")
            .args_json(json!({"hash": hash, "log_index": 1}))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    alice
        .call(contract.id(), "storage_deposit")
        .args_json(json!({"account_id": alice.id(), "registration_only": true}))
        .deposit(NearToken::from_millinear(20))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let too_much = alice
        .call(contract.id(), "claim_representation")
        .args_json(json!({"beneficiary": alice.id(), "amount": "100"}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(too_much.into_result().is_err());
    alice
        .call(contract.id(), "claim_representation")
        .args_json(json!({"beneficiary": alice.id(), "amount": "98"}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    // A receiver without ft_on_transfer fails; the standard resolver must
    // return the amount without changing supply or the backing ledger.
    owner
        .call(contract.id(), "storage_deposit")
        .args_json(json!({"account_id": owner.id(), "registration_only": true}))
        .deposit(NearToken::from_millinear(20))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let transfer = alice
        .call(contract.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": owner.id(), "amount": "10", "msg": ""}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    transfer.into_result()?;
    let balance: String = contract
        .view("ft_balance_of")
        .args_json(json!({"account_id": alice.id()}))
        .await?
        .json()?;
    assert_eq!(balance, "98");
    let state: serde_json::Value = contract
        .view("get_ledger")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(state["minted"], "98");
    assert_eq!(state["accounting_balanced"], true);
    for _ in 0..2 {
        contract
            .call("fixture_reserve")
            .args_json(
                json!({"holder": alice.id(), "request": 1, "amount": "60", "disposal": false}),
            )
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    let conflicting = contract
        .call("fixture_reserve")
        .args_json(json!({"holder": alice.id(), "request": 2, "amount": "60", "disposal": true}))
        .max_gas()
        .transact()
        .await?;
    assert!(conflicting.into_result().is_err());
    contract
        .call("fixture_reserve")
        .args_json(json!({"holder": alice.id(), "request": 2, "amount": "38", "disposal": true}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    contract
        .call("fixture_broadcast")
        .args_json(json!({"holder": alice.id(), "request": 1, "transaction": 7}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    contract
        .call("fixture_reorganize")
        .args_json(json!({"hash": hash, "log_index": 1}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let resume = owner
        .call(contract.id(), "set_paused")
        .args_json(json!({"paused": false}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(resume.into_result().is_err());
    let ledger: serde_json::Value = contract
        .view("get_ledger")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(ledger["custody"], "98");
    assert_eq!(ledger["minted"], "0");
    assert_eq!(ledger["payouts"], "60");
    assert_eq!(ledger["disposal"], "38");
    assert_eq!(ledger["accounting_balanced"], true);
    assert_eq!(ledger["reconciliation_required"], true);
    Ok(())
}
