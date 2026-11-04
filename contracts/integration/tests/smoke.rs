mod common;

use serde_json::json;

#[tokio::test]
async fn sandbox_runs_and_accepts_the_contract_wasm() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let ft = worker.dev_deploy(&common::wasm("valtrum_mock_ft")).await?;
    ft.call("new")
        .args_json(json!({ "name": "Mock USDC", "symbol": "USDC", "decimals": 6 }))
        .transact()
        .await?
        .into_result()?;

    let alice = worker.dev_create_account().await?;
    ft.call("mint")
        .args_json(json!({ "account_id": alice.id(), "amount": "1000000" }))
        .transact()
        .await?
        .into_result()?;

    let balance: String = ft
        .view("ft_balance_of")
        .args_json(json!({ "account_id": alice.id() }))
        .await?
        .json()?;
    assert_eq!(balance, "1000000");
    Ok(())
}
