mod common;

use common::*;
use serde_json::{json, Value};

/// Full Robinhood token addresses so the constrained payout transaction can
/// be built against a real 20-byte contract address.
const TOKEN_A: &str = "0x1111111111111111111111111111111111111111";
const TOKEN_B: &str = "0x2222222222222222222222222222222222222222";
/// Alice's registered Robinhood recipient address.
const RECIPIENT: &str = "0x3333333333333333333333333333333333333333";

fn from_hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

fn word_hex(value: u128) -> String {
    format!("{value:064x}")
}

/// ERC-20 `transfer(to, amount)` calldata.
fn transfer_calldata(to: &str, amount: u128) -> Vec<u8> {
    let to_word = format!("{:024x}{}", 0u64, to.trim_start_matches("0x"));
    from_hex(&format!("a9059cbb{to_word}{}", word_hex(amount)))
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

fn addr_bytes(address: &str) -> Vec<u8> {
    from_hex(address.trim_start_matches("0x"))
}

/// A constrained payout transaction for `payout_id`'s reservation.
fn payout_tx(nonce: u64, amount: u128) -> Value {
    json!({
        "chain_id": CHAIN_ID,
        "nonce": nonce,
        "max_priority_fee_per_gas": "1000000",
        "max_fee_per_gas": "2000000000",
        "gas_limit": 120000,
        "to": addr_bytes(TOKEN_B),
        "value": "0",
        "data": transfer_calldata(RECIPIENT, amount),
    })
}

/// Runs a battle to the point where community 1's vault is allocated and
/// `beneficiary` holds a `q`-unit payout reservation on backing_b.
async fn settled_payout(
    env: &Env,
) -> anyhow::Result<(u64, u64, near_workspaces::Account)> {
    let alice = env.user("alice").await?;
    let bob = env.user("bob").await?;
    let carol = env.user("carol").await?;
    env.grant_representation(&alice, &env.backing_a, 500, 1).await?;
    env.grant_representation(&bob, &env.backing_a, 500, 2).await?;
    env.grant_representation(&carol, &env.backing_b, 1000, 3).await?;
    let id = env.create_and_audit_with(&alice, TOKEN_A, TOKEN_B).await?;
    env.deposit(&alice, &env.backing_a, 500, id, 0).await?.into_result()?;
    env.deposit(&bob, &env.backing_a, 500, id, 0).await?.into_result()?;
    env.deposit(&carol, &env.backing_b, 1000, id, 1).await?.into_result()?;
    env.lock(id).await?;
    env.submit_prices(id, 110, 105).await?;
    env.resolve(id).await?;
    assert_eq!(env.battle(id).await?["winner"], json!(0));
    env.arena_call(&env.auditor, "allocate_loser", json!({ "battle_id": id, "community_index": 1 }))
        .await?
        .into_result()?;
    alice
        .call(env.arena.id(), "register_recipient")
        .args_json(json!({ "address": RECIPIENT }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    env.arena_call(
        &alice,
        "request_payout",
        json!({
            "battle_id": id,
            "community_index": 1,
            "beneficiary": alice.id(),
            "q": "500",
        }),
    )
    .await?
    .into_result()?;
    let payout: Value = env
        .backing_b
        .view("payout")
        .args_json(json!({ "payout_id": 0 }))
        .await?
        .json()?;
    assert_eq!(payout["amount"].as_str(), Some("500"));
    Ok((id, payout["nonce"].as_u64().unwrap_or_default(), alice))
}

#[tokio::test]
async fn a_constrained_payout_signature_yields_a_well_formed_signed_transaction() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (battle_id, nonce, _alice) = settled_payout(&env).await?;

    env.arena_call(&env.auditor, "request_signature", json!({
        "payout_id": 0,
        "tx": payout_tx(nonce, 500),
    }))
    .await?
    .into_result()?;

    let view = env.arena_view("sign_request", json!({ "request_id": 1 })).await?;
    assert_eq!(view["status"], "Signed", "the MPC round trip must finish in-gas");
    assert_eq!(view["path"], "valtrum-payout-0");
    assert_eq!(view["attempts"], 0);
    assert_eq!(view["payout_id"], 0);

    let signed_bytes: Vec<u8> = view["signed_tx"]
        .as_array()
        .expect("signed tx bytes")
        .iter()
        .map(|b| b.as_u64().unwrap_or_default() as u8)
        .collect();
    let signed = tx_items(&signed_bytes);
    assert_eq!(signed.len(), 11, "eight fields plus yParity, r and s");
    assert_eq!(be(&signed[0]), CHAIN_ID.into(), "chain id");
    assert_eq!(be(&signed[1]), nonce.into(), "nonce");
    assert_eq!(be(&signed[2]), 1_000_000, "priority fee");
    assert_eq!(be(&signed[3]), 2_000_000_000, "max fee");
    assert_eq!(be(&signed[4]), 120_000, "gas limit");
    assert_eq!(signed[5], addr_bytes(TOKEN_B), "the transfer goes to the token");
    assert_eq!(be(&signed[6]), 0, "no value");
    assert_eq!(&signed[7][..4], &[0xa9, 0x05, 0x9c, 0xbb], "transfer selector");
    assert_eq!(
        &signed[7][4 + 12..4 + 32],
        addr_bytes(RECIPIENT),
        "the recipient is the registered address"
    );
    assert!(be(&signed[8]) <= 1, "yParity is 0 or 1");
    assert!(!signed[9].is_empty() && signed[9].len() <= 32, "r");
    assert!(!signed[10].is_empty() && signed[10].len() <= 32, "s");

    // the mock signs deterministically: a fresh request for the same payout
    // produces the same transaction
    let first = view["signed_tx"].clone();
    env.arena_call(&env.auditor, "request_signature", json!({
        "payout_id": 0,
        "tx": payout_tx(nonce, 500),
    }))
    .await?
    .into_result()?;
    let again = env.arena_view("sign_request", json!({ "request_id": 2 })).await?;
    assert_eq!(again["signed_tx"], first, "same reservation signs the same");
    let _ = battle_id;
    Ok(())
}

#[tokio::test]
async fn a_signature_request_that_deviates_from_the_reservation_is_refused() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (_battle_id, nonce, _alice) = settled_payout(&env).await?;

    let mut tampered = payout_tx(nonce, 500);
    tampered["data"] = json!(transfer_calldata(RECIPIENT, 499));
    assert!(env.arena_call(&env.auditor, "request_signature", json!({
        "payout_id": 0, "tx": tampered,
    })).await?.into_result().is_err(), "a different amount must be refused");

    let mut tampered = payout_tx(nonce, 500);
    tampered["nonce"] = json!(nonce + 1);
    assert!(env.arena_call(&env.auditor, "request_signature", json!({
        "payout_id": 0, "tx": tampered,
    })).await?.into_result().is_err(), "a different nonce must be refused");

    let mut tampered = payout_tx(nonce, 500);
    tampered["to"] = json!(addr_bytes(TOKEN_A));
    assert!(env.arena_call(&env.auditor, "request_signature", json!({
        "payout_id": 0, "tx": tampered,
    })).await?.into_result().is_err(), "a different token must be refused");

    // a transaction for a reservation that does not exist is refused too
    assert!(env.arena_call(&env.auditor, "request_signature", json!({
        "payout_id": 999, "tx": payout_tx(nonce, 500),
    })).await?.into_result().is_err(), "an unknown payout must be refused");

    // nothing was recorded for any refused request
    let count = env.arena_view("sign_request", json!({ "request_id": 1 })).await?;
    assert!(count.is_null());
    Ok(())
}

#[tokio::test]
async fn a_signing_failure_can_be_retried_until_it_works() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (_battle_id, nonce, _alice) = settled_payout(&env).await?;

    env.mpc
        .call("set_fail")
        .args_json(json!({ "fail": true }))
        .transact()
        .await?
        .into_result()?;
    env.arena_call(&env.auditor, "request_signature", json!({
        "payout_id": 0, "tx": payout_tx(nonce, 500),
    }))
    .await?
    .into_result()?;
    let view = env.arena_view("sign_request", json!({ "request_id": 1 })).await?;
    assert_eq!(view["status"], "Failed");
    assert_eq!(view["attempts"], 1);
    assert!(view["signed_tx"].is_null());

    // still failing: the retry fails again and counts
    env.arena_call(&env.auditor, "retry_signature", json!({ "request_id": 1 }))
        .await?
        .into_result()?;
    assert_eq!(env.arena_view("sign_request", json!({ "request_id": 1 })).await?["attempts"], 2);

    env.mpc
        .call("set_fail")
        .args_json(json!({ "fail": false }))
        .transact()
        .await?
        .into_result()?;
    env.arena_call(&env.auditor, "retry_signature", json!({ "request_id": 1 }))
        .await?
        .into_result()?;
    let view = env.arena_view("sign_request", json!({ "request_id": 1 })).await?;
    println!("retried view: {view}");
    assert_eq!(view["status"], "Signed");
    assert!(view["signed_tx"].is_array(), "the retry eventually signs");

    // the mock is deterministic: the retried signature matches a fresh one
    env.arena_call(&env.auditor, "request_signature", json!({
        "payout_id": 0, "tx": payout_tx(nonce, 500),
    }))
    .await?
    .into_result()?;
    let fresh = env.arena_view("sign_request", json!({ "request_id": 2 })).await?;
    assert_eq!(fresh["signed_tx"], view["signed_tx"], "same payload signs the same");
    Ok(())
}

#[tokio::test]
async fn only_workers_may_request_signatures_and_callbacks_are_private() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (_battle_id, nonce, _alice) = settled_payout(&env).await?;

    let bob = env.user("dave").await?;
    let outsider = env
        .arena_call(&bob, "request_signature", json!({
            "payout_id": 0, "tx": payout_tx(nonce, 500),
        }))
        .await?;
    assert!(outsider.into_result().is_err(), "only workers may sign");

    let forged = env
        .arena_call(&bob, "on_signature", json!({ "request_id": 1 }))
        .await?;
    assert!(forged.into_result().is_err(), "the callback is private");
    Ok(())
}