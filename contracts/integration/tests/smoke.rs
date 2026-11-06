mod common;

use common::*;
use serde_json::{json, Value};

/// A minimal deployment sanity check: contracts deploy, the configuration is
/// set and the arena starts empty.
#[tokio::test]
async fn the_network_deploys_and_reports_its_configuration() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let config: Value = env.arena_view("config", json!({})).await?;
    assert_eq!(config["owner"].as_str(), Some(env.owner.id().as_str()));
    assert_eq!(
        config["protocol"].as_str(),
        Some(env.protocol.id().as_str())
    );
    assert_eq!(config["foreign"]["chain_id"], CHAIN_ID);
    assert_eq!(
        config["foreign"]["mpc_contract"].as_str(),
        Some(env.mpc.id().as_str())
    );
    assert_eq!(config["policy"]["version"], 1);
    assert_eq!(
        env.arena_view("battles", json!({ "from": 0, "limit": 100 }))
            .await?,
        json!([])
    );
    Ok(())
}
