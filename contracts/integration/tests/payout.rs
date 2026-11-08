mod common;

use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

const TOKEN: &str = "0x0000000000000000000000000000000000000001";

fn token_bytes() -> Vec<u8> {
    let mut bytes = vec![0u8; 19];
    bytes.push(1);
    bytes
}

struct World {
    backing: Contract,
    payout: Contract,
    /// Sandbox fixture standing in for the NEAR MPC signer; not live evidence.
    mpc: Contract,
    registry: Contract,
    verifier: Account,
    arena: Account,
    alice: Account,
    relayer: Account,
    operator: Account,
}

/// Synthetic setup: the registry claim, operator evidence and nonces below are
/// test fixtures, not live finality or custody.
async fn world() -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let registry = worker
        .dev_deploy(&common::wasm("valtrum_receipt_registry"))
        .await?;
    let backing = worker.dev_deploy(&common::wasm("valtrum_backing")).await?;
    let payout = worker.dev_deploy(&common::wasm("valtrum_payout")).await?;
    let mpc = worker.dev_deploy(&common::wasm("valtrum_mock_mpc")).await?;
    mpc.call("new").transact().await?.into_result()?;
    let owner = worker.dev_create_account().await?;
    let verifier = worker.dev_create_account().await?;
    // Sandbox stand-in for the arena's lock view (battle 1 open); it also signs
    // as the arena account.
    let arena_contract = worker
        .dev_deploy(&common::wasm("valtrum_mock_lifecycle"))
        .await?;
    arena_contract.call("new").transact().await?.into_result()?;
    arena_contract
        .call("set_battle")
        .args_json(json!({"battle_id": "1", "locked": false}))
        .transact()
        .await?
        .into_result()?;
    let arena = arena_contract.as_account().clone();
    let alice = worker.dev_create_account().await?;
    let relayer = worker.dev_create_account().await?;
    let operator = worker.dev_create_account().await?;
    registry
        .call("new")
        .args_json(json!({"owner": owner.id(), "verifier": verifier.id()}))
        .transact()
        .await?
        .into_result()?;
    backing.call("new").args_json(json!({
        "owner": owner.id(),
        "asset": { "chain_id": "46630", "token_address": TOKEN, "custody_domain": "fixture", "source_decimals": 18, "representation_decimals": 18 },
        "name": "Representation fixture", "symbol": "TEST",
        "registry": registry.id(), "mapping_version": "1", "arena": arena.id(), "payout": payout.id()
    })).max_gas().transact().await?.into_result()?;
    payout
        .call("new")
        .args_json(json!({"owner": owner.id(), "operator": operator.id(), "relayer": relayer.id(), "signer": mpc.id()}))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(registry.id(), "set_representation")
        .args_json(json!({"representation": backing.id(), "allowed": true}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(payout.id(), "register_backing")
        .deposit(NearToken::from_yoctonear(1))
        .args_json(json!({"backing": backing.id(), "config": {
            "chain_id": "46630", "token": token_bytes(), "custody_domain": "fixture",
            "sender": vec![2u8; 20], "path": "custody-1", "first_nonce": "5",
            "gas_limit": "100000", "max_fee_cap": "1000"
        }}))
        .transact()
        .await?
        .into_result()?;
    // The arena receives the attested custody and holds it as the locked vault.
    let key = json!({"chain_id": "46630", "transaction_hash": vec![1u8; 32], "log_index": 1});
    let claim = json!({"representation": backing.id(), "token_address": TOKEN, "custody_domain": "fixture", "mapping_version": "1", "beneficiary": arena.id(), "refund_address": vec![0xbeu8; 20], "battle_id": "1", "actual_received": "98", "block_number": "3", "block_hash": vec![2u8; 32], "finalized_head_number": "4", "finalized_head_hash": vec![3u8; 32], "evidence_hash": vec![4u8; 32]});
    verifier
        .call(registry.id(), "attest")
        .args_json(json!({"key": key, "claim": claim}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let credited = relayer
        .call(backing.id(), "claim_receipt")
        .args_json(json!({"transaction_hash": format!("0x{}", "01".repeat(32)), "log_index": 1}))
        .deposit(NearToken::from_millinear(20))
        .max_gas()
        .transact()
        .await?;
    assert!(credited.into_result()?.json::<bool>()?);
    arena
        .call(backing.id(), "storage_deposit")
        .args_json(json!({"account_id": arena.id(), "registration_only": true}))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    arena
        .call(backing.id(), "claim_representation")
        .args_json(json!({"beneficiary": arena.id(), "amount": "98"}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    arena
        .call(backing.id(), "allocate_entitlement")
        .args_json(
            json!({"allocation_id": vec![9u8; 32], "beneficiary": alice.id(), "amount": "98"}),
        )
        .deposit(NearToken::from_millinear(20))
        .transact()
        .await?
        .into_result()?;
    Ok(World {
        backing,
        payout,
        mpc,
        registry,
        verifier,
        arena,
        alice,
        relayer,
        operator,
    })
}

fn evidence(amount: &str, tx: &Value) -> Value {
    json!({"chain_id": "46630", "token": token_bytes(), "sender": vec![2u8; 20], "recipient": vec![3u8; 20],
        "amount": amount, "tx_hash": tx, "log_index": 0, "block_hash": vec![8u8; 32],
        "block_number": "10", "finalized_head_number": "12", "finalized_head_hash": vec![9u8; 32],
        "evidence_hash": vec![7u8; 32]})
}

async fn status(w: &World, request: u8) -> anyhow::Result<Option<String>> {
    Ok(w.payout
        .view("get_payout_status")
        .args_json(json!({"backing": w.backing.id(), "holder": w.alice.id(), "request_id": vec![request; 32]}))
        .await?
        .json()?)
}

async fn request(w: &World, request: u8, amount: &str) -> anyhow::Result<bool> {
    Ok(w.alice
        .call(w.payout.id(), "request_payout")
        .args_json(json!({"backing": w.backing.id(), "request_id": vec![request; 32], "amount": amount, "destination": vec![3u8; 20]}))
        .deposit(NearToken::from_millinear(30))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json::<bool>()
        .unwrap_or(false))
}

fn id(w: &World, request: u8) -> Value {
    json!({"backing": w.backing.id(), "holder": w.alice.id(), "request_id": vec![request; 32]})
}

async fn view(w: &World, request: u8) -> anyhow::Result<Value> {
    Ok(w.payout
        .view("get_payout")
        .args_json(id(w, request))
        .await?
        .json()?)
}

/// Calls a payout method as `account` with one yocto and returns whether it succeeded.
async fn drive(w: &World, account: &Account, method: &str, args: Value) -> anyhow::Result<bool> {
    Ok(account
        .call(w.payout.id(), method)
        .deposit(NearToken::from_yoctonear(1))
        .args_json(args)
        .max_gas()
        .transact()
        .await?
        .into_result()
        .is_ok())
}

fn with(mut base: Value, extra: Value) -> Value {
    for (key, value) in extra.as_object().expect("object").clone() {
        base[key] = value;
    }
    base
}

async fn sign(w: &World, request: u8, fee: &str) -> anyhow::Result<bool> {
    drive(
        w,
        &w.relayer,
        "request_signature",
        with(id(w, request), json!({"max_fee_per_gas": fee})),
    )
    .await
}

async fn set_signer_failure(w: &World, fail: bool) -> anyhow::Result<()> {
    w.mpc
        .call("set_fail")
        .args_json(json!({ "fail": fail }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

fn attempt_hash(view: &Value, index: usize) -> Value {
    view["attempts"][index]["tx_hash"].clone()
}

#[tokio::test]
async fn payout_roles_are_separate_and_confirmation_consumes_backing_once() -> anyhow::Result<()> {
    let w = world().await?;
    // Only an entitlement holder can reserve; an account without one is rejected.
    let stranger = w
        .operator
        .call(w.payout.id(), "request_payout")
        .args_json(json!({"backing": w.backing.id(), "request_id": vec![1u8; 32], "amount": "10", "destination": vec![3u8; 20]}))
        .deposit(NearToken::from_millinear(30))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert!(!stranger.json::<bool>().unwrap_or(false));
    assert_eq!(status(&w, 1).await?, None);

    assert!(request(&w, 1, "60").await?);
    assert!(request(&w, 1, "60").await?); // identical repeat is idempotent
    assert_eq!(status(&w, 1).await?.as_deref(), Some("authorized"));
    let payload: Value = w
        .payout
        .view("get_signing_payload")
        .args_json(id(&w, 1))
        .await?
        .json()?;
    assert_eq!(payload["amount"], "60");
    assert_eq!(payload["nonce"], "5");
    assert_eq!(payload["gas_limit"], "100000");

    // Role misuse: holder, operator, the backing's other roles and the signer cannot request signing.
    let signer = w.mpc.as_account();
    for account in [&w.alice, &w.operator, &w.arena, signer] {
        assert!(
            !drive(
                &w,
                account,
                "request_signature",
                with(id(&w, 1), json!({"max_fee_per_gas": "10"}))
            )
            .await?
        );
    }
    assert_eq!(status(&w, 1).await?.as_deref(), Some("authorized"));
    assert_eq!(w.mpc.view("get_signed_count").await?.json::<u64>()?, 0);
    // The fee cap registered for the backing bounds what the relayer may ask for.
    assert!(!sign(&w, 1, "1001").await?);
    assert!(!sign(&w, 1, "0").await?);

    // The relayer cannot choose recipient or amount: extra arguments are ignored
    // and the signed transaction carries the reservation's parameters.
    assert!(
        drive(
            &w,
            &w.relayer,
            "request_signature",
            with(id(&w, 1), json!({"max_fee_per_gas": "10", "destination": vec![4u8; 20], "amount": "99", "nonce": "9"})),
        )
        .await?
    );
    assert_eq!(status(&w, 1).await?.as_deref(), Some("signed"));
    assert_eq!(w.mpc.view("get_signed_count").await?.json::<u64>()?, 1);
    let signed_view = view(&w, 1).await?;
    assert_eq!(signed_view["attempts"][0]["state"], "signed");
    let tx_hash = attempt_hash(&signed_view, 0);
    let raw: Option<String> = w
        .payout
        .view("get_signed_transaction")
        .args_json(with(id(&w, 1), json!({"tx_hash": tx_hash})))
        .await?
        .json()?;
    let raw = raw.expect("signed transaction");
    assert!(raw.starts_with("02f8"), "EIP-1559 typed transaction");
    // ERC-20 transfer(recipient 0x03..03, 60), recipient word then amount word.
    let call = format!("a9059cbb{}{}{:064x}", "0".repeat(24), "03".repeat(20), 60);
    assert!(
        raw.contains(&call),
        "calldata is built from the reservation"
    );
    assert!(!raw.contains(&"04".repeat(20)));

    // A repeat or a lower fee is refused; the signer is not asked again.
    assert!(!sign(&w, 1, "10").await?);
    assert!(!sign(&w, 1, "9").await?);
    assert_eq!(w.mpc.view("get_signed_count").await?.json::<u64>()?, 1);
    // The signature callback is private and the old reporting methods are gone.
    for account in [&w.relayer, &w.operator, &w.alice, signer] {
        assert!(
            !drive(
                &w,
                account,
                "on_signature",
                with(id(&w, 1), json!({"max_fee_per_gas": "11"}))
            )
            .await?
        );
        assert!(
            !drive(
                &w,
                account,
                "record_signature",
                with(id(&w, 1), json!({"tx_hash": vec![7u8; 32], "binding_hash": vec![1u8; 32], "max_fee_per_gas": "11"})),
            )
            .await?
        );
    }
    assert_eq!(
        view(&w, 1).await?["attempts"].as_array().map(Vec::len),
        Some(1)
    );

    // Only the relayer records a broadcast; the operator or relayer a sighting.
    let hash_args = |hash: &Value| with(id(&w, 1), json!({"tx_hash": hash}));
    assert!(!drive(&w, &w.operator, "record_broadcast", hash_args(&tx_hash)).await?);
    assert!(drive(&w, &w.relayer, "record_broadcast", hash_args(&tx_hash)).await?);
    assert_eq!(status(&w, 1).await?.as_deref(), Some("broadcast"));
    assert!(!drive(&w, &w.alice, "record_pending_finality", hash_args(&tx_hash)).await?);
    assert!(
        drive(
            &w,
            &w.operator,
            "record_pending_finality",
            hash_args(&tx_hash)
        )
        .await?
    );
    assert_eq!(status(&w, 1).await?.as_deref(), Some("pending_finality"));

    // Neither a signature nor a broadcast confirms; only the operator can, with exact evidence.
    let confirm =
        |amount: &str, hash: &Value| with(id(&w, 1), json!({"evidence": evidence(amount, hash)}));
    for account in [&w.alice, &w.relayer] {
        assert!(!drive(&w, account, "confirm_payout", confirm("60", &tx_hash)).await?);
    }
    assert!(!drive(&w, &w.operator, "confirm_payout", confirm("59", &tx_hash)).await?);
    let mut wrong_recipient = confirm("60", &tx_hash);
    wrong_recipient["evidence"]["recipient"] = json!(vec![4u8; 20]);
    assert!(!drive(&w, &w.operator, "confirm_payout", wrong_recipient).await?);
    assert!(
        !drive(
            &w,
            &w.operator,
            "confirm_payout",
            confirm("60", &json!(vec![5u8; 32]))
        )
        .await?
    );
    assert_eq!(status(&w, 1).await?.as_deref(), Some("pending_finality"));
    assert!(drive(&w, &w.operator, "confirm_payout", confirm("60", &tx_hash)).await?);
    assert_eq!(status(&w, 1).await?.as_deref(), Some("confirmed"));
    let confirmed = view(&w, 1).await?;
    assert_eq!(confirmed["terminal"], true);
    assert_eq!(confirmed["evidence_hash"], json!(vec![7u8; 32]));
    let ledger: Value = w
        .backing
        .view("get_ledger")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(ledger["custody"], "38");
    assert_eq!(ledger["payouts"], "0");
    assert_eq!(ledger["entitlements"], "38");
    assert_eq!(ledger["accounting_balanced"], true);
    // Replaying the same evidence changes nothing; a closed payout takes no new signature.
    assert!(drive(&w, &w.operator, "confirm_payout", confirm("60", &tx_hash)).await?);
    let again: Value = w
        .backing
        .view("get_ledger")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(again["custody"], "38");
    assert!(!sign(&w, 1, "50").await?);
    Ok(())
}

#[tokio::test]
async fn unsigned_payouts_can_be_cancelled_but_signed_ones_need_nonce_proof() -> anyhow::Result<()>
{
    let w = world().await?;
    assert!(request(&w, 2, "38").await?);
    // Holders and relayers cannot release; the operator can cancel an unsigned payout.
    let cancel = |request: u8| with(id(&w, request), json!({"proof": Value::Null}));
    for account in [&w.alice, &w.relayer] {
        assert!(!drive(&w, account, "restore_payout", cancel(2)).await?);
    }
    assert!(drive(&w, &w.operator, "restore_payout", cancel(2)).await?);
    assert_eq!(status(&w, 2).await?.as_deref(), Some("restored"));
    let held: String = w
        .backing
        .view("entitlement_of")
        .args_json(json!({"account": w.alice.id()}))
        .await?
        .json()?;
    assert_eq!(held, "98");

    // A failed signer call may still hide a signature: no cancellation without proof.
    assert!(request(&w, 3, "38").await?);
    set_signer_failure(&w, true).await?;
    assert!(sign(&w, 3, "10").await?);
    let held_view = view(&w, 3).await?;
    assert_eq!(held_view["state"], "reconciliation_required");
    assert_eq!(held_view["reason"], "SignerNoResponse");
    assert!(held_view["attempts"].as_array().is_some_and(Vec::is_empty));
    assert!(!drive(&w, &w.operator, "restore_payout", cancel(3)).await?);
    // A proof that the custody nonce was consumed by another transaction releases it.
    let proof = with(
        id(&w, 3),
        json!({"proof": {"chain_id": "46630", "sender": vec![2u8; 20], "finalized_nonce": "7",
            "outcome": {"ForeignTx": vec![6u8; 32]}, "finalized_head_number": "12",
            "finalized_head_hash": vec![9u8; 32]}}),
    );
    assert!(drive(&w, &w.operator, "restore_payout", proof).await?);
    assert_eq!(status(&w, 3).await?.as_deref(), Some("restored"));
    let ledger: Value = w
        .backing
        .view("get_ledger")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(ledger["payouts"], "0");
    assert_eq!(ledger["entitlements"], "98");
    assert_eq!(ledger["accounting_balanced"], true);
    Ok(())
}

#[tokio::test]
async fn signer_failure_retry_replacement_revert_and_every_state() -> anyhow::Result<()> {
    let w = world().await?;
    assert!(request(&w, 4, "50").await?);
    // A failing signer holds the payout; the retry may reuse the fee because
    // the failed call left no attempt behind.
    set_signer_failure(&w, true).await?;
    assert!(sign(&w, 4, "10").await?);
    assert_eq!(
        status(&w, 4).await?.as_deref(),
        Some("reconciliation_required")
    );
    set_signer_failure(&w, false).await?;
    assert!(sign(&w, 4, "10").await?);
    assert_eq!(status(&w, 4).await?.as_deref(), Some("signed"));
    let first = attempt_hash(&view(&w, 4).await?, 0);

    // Replacement: same nonce, strictly higher fee, both attempts stay on record.
    assert!(!sign(&w, 4, "10").await?);
    assert!(sign(&w, 4, "20").await?);
    let both = view(&w, 4).await?;
    assert_eq!(both["attempts"].as_array().map(Vec::len), Some(2));
    assert_eq!(both["nonce"], "5");
    let second = attempt_hash(&both, 1);
    assert_ne!(first, second);

    // An open payout is listed for reconciliation until it is terminal.
    let page: Value = w
        .payout
        .view("list_open_payouts")
        .args_json(json!({"from_index": "0", "limit": "50"}))
        .await?
        .json()?;
    assert_eq!(page["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(page["items"][0]["state"], "signed");
    assert_eq!(page["next_index"], "1");
    assert_eq!(
        w.payout.view("get_payout_count").await?.json::<String>()?,
        "1"
    );

    // Broadcast, then a revert of one attempt keeps the payout alive; both reverted -> reverted.
    let hash_args = |hash: &Value| with(id(&w, 4), json!({"tx_hash": hash}));
    assert!(drive(&w, &w.relayer, "record_broadcast", hash_args(&first)).await?);
    assert!(drive(&w, &w.operator, "record_revert", hash_args(&first)).await?);
    assert_eq!(status(&w, 4).await?.as_deref(), Some("broadcast"));
    assert!(
        drive(
            &w,
            &w.operator,
            "require_reconciliation",
            with(id(&w, 4), json!({"reason": "BroadcastUnconfirmed"}))
        )
        .await?
    );
    assert_eq!(
        status(&w, 4).await?.as_deref(),
        Some("reconciliation_required")
    );
    assert!(drive(&w, &w.operator, "record_revert", hash_args(&second)).await?);
    let reverted = view(&w, 4).await?;
    assert_eq!(reverted["state"], "reverted");
    assert_eq!(reverted["terminal"], false);
    // A reverted payout accepts no new signature and cannot be confirmed.
    assert!(!sign(&w, 4, "30").await?);
    assert!(
        !drive(
            &w,
            &w.operator,
            "confirm_payout",
            with(id(&w, 4), json!({"evidence": evidence("50", &second)}))
        )
        .await?
    );
    // Only a finalized nonce slot releases it; a success proof must be confirmed instead.
    let slot = |outcome: Value| {
        with(
            id(&w, 4),
            json!({"proof": {"chain_id": "46630", "sender": vec![2u8; 20], "finalized_nonce": "6",
            "outcome": outcome, "finalized_head_number": "12", "finalized_head_hash": vec![9u8; 32]}}),
        )
    };
    assert!(
        !drive(
            &w,
            &w.operator,
            "restore_payout",
            slot(json!({"OurTxSucceeded": second}))
        )
        .await?
    );
    assert!(
        drive(
            &w,
            &w.operator,
            "restore_payout",
            slot(json!({"OurTxReverted": second}))
        )
        .await?
    );
    assert_eq!(status(&w, 4).await?.as_deref(), Some("restored"));
    let page: Value = w
        .payout
        .view("list_open_payouts")
        .args_json(json!({"from_index": "0", "limit": "50"}))
        .await?
        .json()?;
    assert_eq!(page["items"].as_array().map(Vec::len), Some(0));
    let ledger: Value = w
        .backing
        .view("get_ledger")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(ledger["payouts"], "0");
    assert_eq!(ledger["accounting_balanced"], true);
    Ok(())
}

#[tokio::test]
async fn two_payouts_get_distinct_nonces_and_payloads() -> anyhow::Result<()> {
    let w = world().await?;
    assert!(request(&w, 5, "10").await?);
    assert!(request(&w, 6, "10").await?);
    assert!(sign(&w, 5, "10").await?);
    assert!(sign(&w, 6, "10").await?);
    let (a, b) = (view(&w, 5).await?, view(&w, 6).await?);
    assert_eq!(a["nonce"], "5");
    assert_eq!(b["nonce"], "6");
    assert_ne!(attempt_hash(&a, 0), attempt_hash(&b, 0));
    // A transaction hash of the other payout is not an attempt of this one.
    let foreign = with(id(&w, 5), json!({"tx_hash": attempt_hash(&b, 0)}));
    assert!(!drive(&w, &w.relayer, "record_broadcast", foreign).await?);
    Ok(())
}

fn event_names(logs: &[&str]) -> Vec<String> {
    logs.iter()
        .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
        .filter_map(|json| serde_json::from_str::<Value>(json).ok())
        .filter(|event| event["standard"] == "valtrum_payout" && event["version"] == "1.0.0")
        .filter_map(|event| event["event"].as_str().map(str::to_string))
        .collect()
}

#[tokio::test]
async fn the_signer_receives_exactly_the_payload_rebuilt_from_the_reservation() -> anyhow::Result<()>
{
    let w = world().await?;
    assert!(request(&w, 7, "60").await?);
    let outcome = w
        .relayer
        .call(w.payout.id(), "request_signature")
        .deposit(NearToken::from_yoctonear(1))
        .args_json(with(
            id(&w, 7),
            // Tampered recipient, token, amount and nonce arguments are not read.
            json!({"max_fee_per_gas": "10", "destination": vec![4u8; 20], "token": vec![9u8; 20],
                "amount": "99", "nonce": "1", "path": "elsewhere", "payload": "00"}),
        ))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let expected: Option<String> = w
        .payout
        .view("get_signing_hash")
        .args_json(with(id(&w, 7), json!({"max_fee_per_gas": "10"})))
        .await?
        .json()?;
    let expected = expected.expect("signing hash");
    assert_eq!(
        w.mpc.view("get_last_payload").await?.json::<String>()?,
        expected
    );
    assert_eq!(
        w.mpc.view("get_last_path").await?.json::<String>()?,
        "custody-1"
    );
    // A different fee is a different payload; the recipient and amount are fixed.
    let other: Option<String> = w
        .payout
        .view("get_signing_hash")
        .args_json(with(id(&w, 7), json!({"max_fee_per_gas": "11"})))
        .await?
        .json()?;
    assert_ne!(other, Some(expected));
    let raw: Option<String> = w
        .payout
        .view("get_signed_transaction")
        .args_json(with(
            id(&w, 7),
            json!({"tx_hash": attempt_hash(&view(&w, 7).await?, 0)}),
        ))
        .await?
        .json()?;
    let raw = raw.expect("signed transaction");
    assert!(raw.contains(&format!(
        "a9059cbb{}{}{:064x}",
        "0".repeat(24),
        "03".repeat(20),
        60
    )));
    assert!(!raw.contains(&"09".repeat(20)));

    let logs = outcome.logs();
    let names = event_names(&logs);
    assert_eq!(
        names,
        [
            "signature_requested",
            "payout_state_changed",
            "signature_received",
            "payout_state_changed"
        ]
    );
    Ok(())
}

#[tokio::test]
async fn an_unusable_signer_answer_holds_the_payout_and_a_retry_recovers() -> anyhow::Result<()> {
    let w = world().await?;
    assert!(request(&w, 8, "40").await?);
    w.mpc
        .call("set_malformed")
        .args_json(json!({"malformed": true}))
        .transact()
        .await?
        .into_result()?;
    let outcome = w
        .relayer
        .call(w.payout.id(), "request_signature")
        .deposit(NearToken::from_yoctonear(1))
        .args_json(with(id(&w, 8), json!({"max_fee_per_gas": "10"})))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert!(event_names(&outcome.logs()).contains(&"signature_failed".to_string()));
    let held = view(&w, 8).await?;
    assert_eq!(held["state"], "reconciliation_required");
    assert_eq!(held["reason"], "SignerNoResponse");
    assert_eq!(held["terminal"], false);
    assert!(held["attempts"].as_array().is_some_and(Vec::is_empty));
    // The reservation is held: no cancellation without a nonce proof.
    let cancel = with(id(&w, 8), json!({"proof": Value::Null}));
    assert!(!drive(&w, &w.operator, "restore_payout", cancel).await?);
    // The held payout is listed for reconciliation.
    let page: Value = w
        .payout
        .view("list_open_payouts")
        .args_json(json!({"from_index": "0", "limit": "50"}))
        .await?
        .json()?;
    assert_eq!(page["items"][0]["state"], "reconciliation_required");
    w.mpc
        .call("set_malformed")
        .args_json(json!({"malformed": false}))
        .transact()
        .await?
        .into_result()?;
    assert!(sign(&w, 8, "10").await?);
    assert_eq!(status(&w, 8).await?.as_deref(), Some("signed"));
    Ok(())
}

#[tokio::test]
async fn a_conflicting_repeat_request_never_changes_the_authorized_payout() -> anyhow::Result<()> {
    let w = world().await?;
    assert!(request(&w, 9, "60").await?);
    // Same identity with another amount or destination must not overwrite the payout.
    let _ = request(&w, 9, "61").await;
    let _ = w
        .alice
        .call(w.payout.id(), "request_payout")
        .args_json(json!({"backing": w.backing.id(), "request_id": vec![9u8; 32], "amount": "60", "destination": vec![4u8; 20]}))
        .deposit(NearToken::from_millinear(30))
        .max_gas()
        .transact()
        .await?;
    let payout = view(&w, 9).await?;
    assert_eq!(payout["amount"], "60");
    assert_eq!(payout["destination"], json!(vec![3u8; 20]));
    assert_eq!(
        w.payout.view("get_payout_count").await?.json::<String>()?,
        "1"
    );
    Ok(())
}

/// Late deposit (fixture, not live evidence): the arena reports battle 1 locked,
/// so a finalized receipt bound to refund address 0xbe.. becomes a late balance.
async fn late_deposit(w: &World, amount: &str) -> anyhow::Result<()> {
    w.arena
        .call(w.arena.id(), "set_battle")
        .args_json(json!({"battle_id": "1", "locked": true}))
        .transact()
        .await?
        .into_result()?;
    let key = json!({"chain_id": "46630", "transaction_hash": vec![0x21u8; 32], "log_index": 0});
    let claim = json!({"representation": w.backing.id(), "token_address": TOKEN, "custody_domain": "fixture", "mapping_version": "1", "beneficiary": w.alice.id(), "refund_address": vec![0xbeu8; 20], "battle_id": "1", "actual_received": amount, "block_number": "3", "block_hash": vec![2u8; 32], "finalized_head_number": "4", "finalized_head_hash": vec![3u8; 32], "evidence_hash": vec![4u8; 32]});
    w.verifier
        .call(w.registry.id(), "attest")
        .args_json(json!({"key": key, "claim": claim}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let credited = w
        .relayer
        .call(w.backing.id(), "claim_receipt")
        .args_json(json!({"transaction_hash": format!("0x{}", "21".repeat(32)), "log_index": 0}))
        .deposit(NearToken::from_millinear(20))
        .max_gas()
        .transact()
        .await?;
    assert!(credited.into_result()?.json::<bool>()?);
    Ok(())
}

async fn refund_request(
    w: &World,
    account: &Account,
    request: u8,
    amount: &str,
    address: u8,
) -> anyhow::Result<bool> {
    Ok(account
        .call(w.payout.id(), "request_late_refund")
        .args_json(json!({"backing": w.backing.id(), "request_id": vec![request; 32], "amount": amount, "refund_address": vec![address; 20]}))
        .deposit(NearToken::from_millinear(30))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json::<bool>()
        .unwrap_or(false))
}

#[tokio::test]
async fn late_refund_goes_only_to_the_address_bound_at_deposit() -> anyhow::Result<()> {
    let w = world().await?;
    late_deposit(&w, "50").await?;
    let late: String = w
        .backing
        .view("late_balance_of")
        .args_json(json!({"account": w.alice.id()}))
        .await?
        .json()?;
    assert_eq!(late, "50");

    // A destination the NEAR beneficiary picks later is rejected and reserves nothing;
    // an account with no late balance cannot start a refund either.
    assert!(!refund_request(&w, &w.alice, 7, "50", 4).await?);
    assert!(!refund_request(&w, &w.operator, 7, "50", 0xbe).await?);
    assert_eq!(status(&w, 7).await?, None);
    let ledger: Value = w
        .backing
        .view("get_ledger")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(ledger["payouts"], "0");
    assert_eq!(ledger["late_refundable"], "50");

    // The bound address is accepted, idempotently, and drives the existing signing path.
    assert!(refund_request(&w, &w.alice, 7, "50", 0xbe).await?);
    assert!(refund_request(&w, &w.alice, 7, "50", 0xbe).await?);
    assert_eq!(status(&w, 7).await?.as_deref(), Some("authorized"));
    let authorized = view(&w, 7).await?;
    assert_eq!(authorized["destination"], json!(vec![0xbeu8; 20]));
    assert_eq!(authorized["amount"], "50");
    assert!(sign(&w, 7, "10").await?);
    let signed = view(&w, 7).await?;
    let tx_hash = attempt_hash(&signed, 0);
    let raw: Option<String> = w
        .payout
        .view("get_signed_transaction")
        .args_json(with(id(&w, 7), json!({"tx_hash": tx_hash})))
        .await?
        .json()?;
    let raw = raw.expect("signed transaction");
    let call = format!("a9059cbb{}{}{:064x}", "0".repeat(24), "be".repeat(20), 50);
    assert!(raw.contains(&call), "calldata pays the bound address");
    assert!(!raw.contains(&"04".repeat(20)));

    // Finality evidence for another recipient cannot consume the refund.
    let hash_args = with(id(&w, 7), json!({"tx_hash": tx_hash}));
    assert!(drive(&w, &w.relayer, "record_broadcast", hash_args.clone()).await?);
    assert!(drive(&w, &w.operator, "record_pending_finality", hash_args).await?);
    let confirm = |recipient: u8| {
        let mut e = evidence("50", &tx_hash);
        e["recipient"] = json!(vec![recipient; 20]);
        with(id(&w, 7), json!({"evidence": e}))
    };
    assert!(!drive(&w, &w.operator, "confirm_payout", confirm(4)).await?);
    assert_eq!(status(&w, 7).await?.as_deref(), Some("pending_finality"));
    assert!(drive(&w, &w.operator, "confirm_payout", confirm(0xbe)).await?);
    assert_eq!(status(&w, 7).await?.as_deref(), Some("confirmed"));
    let ledger: Value = w
        .backing
        .view("get_ledger")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(ledger["custody"], "98");
    assert_eq!(ledger["payouts"], "0");
    assert_eq!(ledger["late_refundable"], "0");
    assert_eq!(ledger["accounting_balanced"], true);
    Ok(())
}
