mod common;

use common::*;
use near_workspaces::Contract;
use serde_json::{json, Value};

const ROUTER_EVM: &str = "2626664c2603336e57b271c5c0b26f421741e481";
const TREASURY_EVM: &str = "00000000000000000000000000000000000a11ce";
const BURN_EVM: &str = "000000000000000000000000000000000000dead";
const COIN_EVM: &str = "4200000000000000000000000000000000000006";

fn from_hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

/// Decodes one RLP item and returns (payload, bytes consumed).
fn rlp_item(data: &[u8]) -> (Vec<u8>, usize) {
    let first = data[0];
    match first {
        0x00..=0x7f => (vec![first], 1),
        0x80..=0xb7 => {
            let len = (first - 0x80) as usize;
            (data[1..1 + len].to_vec(), 1 + len)
        }
        0xb8..=0xbf => {
            let size = (first - 0xb7) as usize;
            let len = data[1..1 + size]
                .iter()
                .fold(0usize, |n, b| n << 8 | *b as usize);
            (data[1 + size..1 + size + len].to_vec(), 1 + size + len)
        }
        0xc0..=0xf7 => {
            let len = (first - 0xc0) as usize;
            (data[1..1 + len].to_vec(), 1 + len)
        }
        _ => {
            let size = (first - 0xf7) as usize;
            let len = data[1..1 + size]
                .iter()
                .fold(0usize, |n, b| n << 8 | *b as usize);
            (data[1 + size..1 + size + len].to_vec(), 1 + size + len)
        }
    }
}

/// Splits a type-2 transaction into its top-level RLP items.
fn tx_items(tx: &[u8]) -> Vec<Vec<u8>> {
    assert_eq!(tx[0], 0x02, "EIP-1559 transactions start with 0x02");
    let (mut payload, used) = rlp_item(&tx[1..]);
    assert_eq!(used, tx.len() - 1, "one list and nothing after it");
    let mut items = Vec::new();
    while !payload.is_empty() {
        let (item, used) = rlp_item(&payload);
        items.push(item);
        payload.drain(..used);
    }
    items
}

fn be(bytes: &[u8]) -> u128 {
    bytes.iter().fold(0u128, |n, b| n << 8 | *b as u128)
}

async fn setup() -> anyhow::Result<(Env, Contract)> {
    let env = Env::new(5, false).await?;
    let account = env
        .worker
        .root_account()?
        .create_subaccount("mpc")
        .initial_balance(near_workspaces::types::NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let mpc = account
        .deploy(&wasm("valtrum_mock_mpc"))
        .await?
        .into_result()?;
    mpc.call("new").transact().await?.into_result()?;
    env.owner
        .call(env.arena.id(), "set_foreign")
        .args_json(json!({ "config": {
            "mpc_contract": mpc.id(),
            "chain_id": "8453",
            "router": ROUTER_EVM,
            "treasury": TREASURY_EVM,
            "burn": BURN_EVM,
        }}))
        .transact()
        .await?
        .into_result()?;
    let alice = env.user("alice").await?;
    assert_eq!(env.propose(&alice, 10).await?, 1);
    env.arena_call(&env.agent, "approve_battle", json!({ "battle_id": 1 }))
        .await?
        .into_result()?;
    Ok((env, mpc))
}

fn approve_call() -> Value {
    json!({ "kind": "approve", "token": COIN_EVM, "spender": ROUTER_EVM, "amount": "1000000" })
}

fn tx_params() -> Value {
    json!({
        "nonce": "3",
        "max_priority_fee_per_gas": "1000000",
        "max_fee_per_gas": "2000000000",
        "gas_limit": "90000",
    })
}

async fn request(
    env: &Env,
    call: Value,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    env.arena_call(
        &env.agent,
        "request_signature",
        json!({ "battle_id": 1, "call": call, "params": tx_params(), "step_index": null }),
    )
    .await
}

async fn signature(env: &Env, id: u64) -> anyhow::Result<Value> {
    env.arena_view("get_signature_request", json!({ "request_id": id }))
        .await
}

#[tokio::test]
async fn a_signature_request_yields_a_well_formed_signed_transaction() -> anyhow::Result<()> {
    let (env, _mpc) = setup().await?;
    request(&env, approve_call()).await?.into_result()?;

    let view = signature(&env, 1).await?;
    assert_eq!(
        view["status"], "Signed",
        "the MPC round trip must finish within the gas given"
    );
    assert_eq!(view["path"], "valtrum-battle-1");
    assert_eq!(view["attempts"], 0);

    let unsigned = tx_items(&from_hex(view["unsigned_tx"].as_str().unwrap()));
    let signed = tx_items(&from_hex(view["signed_tx"].as_str().unwrap()));
    assert_eq!(unsigned.len(), 9);
    assert_eq!(signed.len(), 12, "nine fields plus yParity, r and s");
    assert_eq!(
        &signed[..9],
        &unsigned[..],
        "signing does not change the payload"
    );

    assert_eq!(be(&signed[0]), 8453, "chain id");
    assert_eq!(be(&signed[1]), 3, "nonce");
    assert_eq!(be(&signed[2]), 1_000_000, "priority fee");
    assert_eq!(be(&signed[3]), 2_000_000_000, "max fee");
    assert_eq!(be(&signed[4]), 90_000, "gas limit");
    assert_eq!(
        signed[5],
        from_hex(COIN_EVM),
        "the approval is sent to the token"
    );
    assert_eq!(be(&signed[6]), 0, "no value");
    assert_eq!(
        &signed[7][..4],
        &[0x09, 0x5e, 0xa7, 0xb3],
        "approve selector"
    );
    assert_eq!(
        &signed[7][4 + 12..4 + 32],
        &from_hex(ROUTER_EVM)[..],
        "spender"
    );
    assert!(be(&signed[9]) <= 1, "yParity is 0 or 1");
    assert!(!signed[10].is_empty() && signed[10].len() <= 32, "r");
    assert!(!signed[11].is_empty() && signed[11].len() <= 32, "s");
    // the payload that was signed is the keccak of the unsigned bytes
    assert_eq!(view["payload_hash"].as_str().unwrap().len(), 64);
    assert_eq!(view["tx_hash"].as_str().unwrap().len(), 64);
    Ok(())
}

#[tokio::test]
async fn a_signing_failure_can_be_retried_until_it_works() -> anyhow::Result<()> {
    let (env, mpc) = setup().await?;
    mpc.call("set_fail")
        .args_json(json!({ "fail": true }))
        .transact()
        .await?
        .into_result()?;
    request(&env, approve_call()).await?.into_result()?;
    let view = signature(&env, 1).await?;
    assert_eq!(view["status"], "Failed");
    assert_eq!(view["attempts"], 1);
    assert!(view["signed_tx"].is_null());
    let payload = view["payload_hash"].clone();

    // still failing: the retry fails again and counts
    env.arena_call(&env.agent, "retry_signature", json!({ "request_id": 1 }))
        .await?
        .into_result()?;
    assert_eq!(signature(&env, 1).await?["attempts"], 2);

    mpc.call("set_fail")
        .args_json(json!({ "fail": false }))
        .transact()
        .await?
        .into_result()?;
    env.arena_call(&env.agent, "retry_signature", json!({ "request_id": 1 }))
        .await?
        .into_result()?;
    let view = signature(&env, 1).await?;
    assert_eq!(view["status"], "Signed");
    assert_eq!(
        view["payload_hash"], payload,
        "a retry signs the same payload"
    );
    assert!(view["signed_tx"].is_string());
    Ok(())
}

#[tokio::test]
async fn only_agents_may_request_and_the_destination_rules_hold() -> anyhow::Result<()> {
    let (env, _mpc) = setup().await?;
    let bob = env.user("bob").await?;
    let outsider = env
        .arena_call(
            &bob,
            "request_signature",
            json!({ "battle_id": 1, "call": approve_call(), "params": tx_params(), "step_index": null }),
        )
        .await?;
    assert!(outsider.into_result().is_err());

    // an approval for anyone but the router, and a transfer to a stranger, are refused
    let bad_spender =
        json!({ "kind": "approve", "token": COIN_EVM, "spender": BURN_EVM, "amount": "1" });
    assert!(request(&env, bad_spender).await?.into_result().is_err());
    let bad_transfer = json!({
        "kind": "transfer", "token": COIN_EVM,
        "to": "00000000000000000000000000000000000bad01", "amount": "1",
    });
    assert!(request(&env, bad_transfer).await?.into_result().is_err());
    let count = env
        .arena_view("get_signature_request_count", json!({}))
        .await?;
    assert_eq!(count, 0, "refused requests leave nothing behind");

    // a transfer to the treasury is fine
    let fee =
        json!({ "kind": "transfer", "token": COIN_EVM, "to": TREASURY_EVM, "amount": "2000000" });
    request(&env, fee).await?.into_result()?;
    assert_eq!(signature(&env, 1).await?["status"], "Signed");
    Ok(())
}

#[tokio::test]
async fn the_signing_callbacks_are_private() -> anyhow::Result<()> {
    let (env, _mpc) = setup().await?;
    let bob = env.user("bob").await?;
    let forged = env
        .arena_call(&bob, "on_signature", json!({ "request_id": 1 }))
        .await?;
    assert!(forged.into_result().is_err());
    Ok(())
}
