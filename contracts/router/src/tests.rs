use super::*;
use msgs::{arena_deposit_msg, dex_swap_msg, unused_after_transfer};
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::testing_env;
use types::Side;

fn acc(name: &str) -> AccountId {
    format!("{name}.testnet").parse().unwrap()
}

fn set_context(predecessor: &str, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("router"))
        .predecessor_account_id(acc(predecessor))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build());
}

fn new_router() -> Router {
    set_context("owner", 0);
    Router::new(acc("owner"), acc("arena"), acc("dex"), acc("usdc"))
}

/// Function calls created so far as (receiver, method, json args).
fn calls() -> Vec<(AccountId, String, Value)> {
    let mut out = Vec::new();
    for receipt in get_created_receipts() {
        for action in receipt.actions {
            if let MockAction::FunctionCallWeight {
                method_name, args, ..
            } = action
            {
                out.push((
                    receipt.receiver_id.clone(),
                    String::from_utf8(method_name).unwrap(),
                    serde_json::from_slice(&args).unwrap_or(Value::Null),
                ));
            }
        }
    }
    out
}

fn swap_deposit_msg() -> String {
    json!({
        "action": "swap_deposit",
        "battle_id": 1,
        "side": "A",
        "beneficiary": "alice.testnet",
        "token_out": "pepe.testnet",
        "min_token_out": "123",
        "from_credit": "35000000",
    })
    .to_string()
}

fn value(result: PromiseOrValue<U128>) -> u128 {
    match result {
        PromiseOrValue::Value(v) => v.0,
        PromiseOrValue::Promise(_) => panic!("expected a value"),
    }
}

fn is_promise(result: &PromiseOrValue<U128>) -> bool {
    matches!(result, PromiseOrValue::Promise(_))
}

fn sample_pending() -> PendingSwap {
    PendingSwap {
        battle_id: 1,
        side: Side::A,
        beneficiary: acc("alice"),
        token_out: acc("pepe"),
        min_token_out: U128(123),
        usdc_in: U128(50_000_000),
        from_credit: U128(35_000_000),
    }
}

/// Starts swap 0 from the arena and clears the receipts it created.
fn router_with_pending() -> Router {
    let mut router = new_router();
    set_context("usdc", 0);
    let result = router.ft_on_transfer(acc("arena"), U128(50_000_000), swap_deposit_msg());
    assert!(is_promise(&result));
    router
}

fn callback_context() {
    set_context("router", 0);
}

// ─── Initialisation, setters and views ───────────────────────────────────

#[test]
fn init_stores_config() {
    let router = new_router();
    let config = router.get_config();
    assert_eq!(config.owner, acc("owner"));
    assert_eq!(config.arena, acc("arena"));
    assert_eq!(config.dex, acc("dex"));
    assert_eq!(config.usdc, acc("usdc"));
    assert!(router.get_pending(0).is_none());
    assert_eq!(router.get_stranded(acc("alice"), acc("pepe")), U128(0));
}

#[test]
fn owner_rotates_arena_and_dex() {
    let mut router = new_router();
    router.set_arena(acc("arena2"));
    router.set_dex(acc("dex2"));
    let config = router.get_config();
    assert_eq!(config.arena, acc("arena2"));
    assert_eq!(config.dex, acc("dex2"));
}

#[test]
#[should_panic(expected = "Only the owner")]
fn stranger_cannot_set_arena() {
    let mut router = new_router();
    set_context("stranger", 0);
    router.set_arena(acc("evil"));
}

#[test]
#[should_panic(expected = "Only the owner")]
fn stranger_cannot_set_dex() {
    let mut router = new_router();
    set_context("stranger", 0);
    router.set_dex(acc("evil"));
}

// ─── Message shapes ──────────────────────────────────────────────────────

#[test]
fn dex_message_matches_protocol() {
    let msg: Value =
        serde_json::from_str(&dex_swap_msg(&sample_pending(), 7, &acc("router"))).unwrap();
    assert_eq!(msg["action"], "swap");
    assert_eq!(msg["token_out"], "pepe.testnet");
    assert_eq!(msg["min_amount_out"], "123");
    assert_eq!(msg["receiver_id"], "router.testnet");
    assert_eq!(msg["receiver_msg"], r#"{"swap_id":7}"#);
}

#[test]
fn arena_message_matches_protocol() {
    let msg: Value = serde_json::from_str(&arena_deposit_msg(&sample_pending())).unwrap();
    assert_eq!(msg["action"], "deposit");
    assert_eq!(msg["battle_id"], 1);
    assert_eq!(msg["side"], "A");
    assert_eq!(msg["beneficiary"], "alice.testnet");
    assert_eq!(msg["usdc_equiv"], "50000000");
    assert_eq!(msg["from_credit"], "35000000");
}

#[test]
fn unused_math_treats_shortfall_and_failure_as_returns() {
    assert_eq!(unused_after_transfer(100, Some(100)), 0);
    assert_eq!(unused_after_transfer(100, Some(40)), 60);
    assert_eq!(unused_after_transfer(100, Some(0)), 100);
    assert_eq!(unused_after_transfer(100, Some(500)), 0);
    assert_eq!(unused_after_transfer(100, None), 100);
}

// ─── Step 2: arena -> router ─────────────────────────────────────────────

#[test]
fn swap_deposit_stores_pending_and_calls_dex() {
    let router = router_with_pending();
    let pending = router.get_pending(0).unwrap();
    assert_eq!(pending, sample_pending());

    let calls = calls();
    assert_eq!(calls.len(), 2);
    let (receiver, method, args) = &calls[0];
    assert_eq!(receiver, &acc("usdc"));
    assert_eq!(method, "ft_transfer_call");
    assert_eq!(args["receiver_id"], "dex.testnet");
    assert_eq!(args["amount"], "50000000");
    let dex_msg: Value = serde_json::from_str(args["msg"].as_str().unwrap()).unwrap();
    assert_eq!(dex_msg["action"], "swap");
    assert_eq!(dex_msg["receiver_id"], "router.testnet");
    assert_eq!(dex_msg["receiver_msg"], r#"{"swap_id":0}"#);
    assert_eq!(calls[1].0, acc("router"));
    assert_eq!(calls[1].1, "on_swap_sent");
    assert_eq!(calls[1].2["swap_id"], 0);
    assert_eq!(calls[1].2["amount"], "50000000");
}

#[test]
fn swap_ids_are_fresh() {
    let mut router = router_with_pending();
    set_context("usdc", 0);
    let _ = router.ft_on_transfer(acc("arena"), U128(10), swap_deposit_msg());
    assert_eq!(router.get_pending(1).unwrap().usdc_in, U128(10));
    assert_eq!(router.get_pending(0).unwrap().usdc_in, U128(50_000_000));
}

#[test]
fn swap_deposit_from_unknown_sender_is_returned() {
    let mut router = new_router();
    set_context("usdc", 0);
    let result = router.ft_on_transfer(acc("stranger"), U128(77), swap_deposit_msg());
    assert_eq!(value(result), 77);
    assert!(router.get_pending(0).is_none());
    assert!(calls().is_empty());
}

#[test]
fn swap_deposit_in_wrong_token_is_returned() {
    let mut router = new_router();
    set_context("pepe", 0);
    let result = router.ft_on_transfer(acc("arena"), U128(77), swap_deposit_msg());
    assert_eq!(value(result), 77);
    assert!(router.get_pending(0).is_none());
    assert!(calls().is_empty());
}

#[test]
fn malformed_messages_are_returned() {
    let mut router = new_router();
    for msg in [
        "",
        "not json",
        "{}",
        r#"{"action":"deposit","battle_id":1}"#,
        r#"{"action":"swap_deposit","battle_id":1}"#,
        r#"{"action":"swap_deposit","battle_id":1,"side":"C","beneficiary":"a.testnet","token_out":"p.testnet","min_token_out":"1","from_credit":"0"}"#,
    ] {
        set_context("usdc", 0);
        let result = router.ft_on_transfer(acc("arena"), U128(5), msg.to_string());
        assert_eq!(value(result), 5, "msg {msg}");
    }
    assert!(router.get_pending(0).is_none());
    assert!(calls().is_empty());
}

#[test]
fn zero_amount_and_usdc_as_output_are_returned() {
    let mut router = new_router();
    set_context("usdc", 0);
    assert_eq!(
        value(router.ft_on_transfer(acc("arena"), U128(0), swap_deposit_msg())),
        0
    );
    let same_token = swap_deposit_msg().replace("pepe.testnet", "usdc.testnet");
    assert_eq!(
        value(router.ft_on_transfer(acc("arena"), U128(9), same_token)),
        9
    );
    assert!(router.get_pending(0).is_none());
}

// ─── Step 3 callback: DEX result ─────────────────────────────────────────

#[test]
fn dex_accepting_all_keeps_pending_and_returns_zero() {
    let mut router = router_with_pending();
    callback_context();
    let unused = router.on_swap_sent(0, U128(50_000_000), Ok(U128(50_000_000)));
    assert_eq!(unused, U128(0));
    assert!(router.get_pending(0).is_some());
}

#[test]
fn dex_refusing_returns_full_usdc_and_drops_pending() {
    let mut router = router_with_pending();
    callback_context();
    let unused = router.on_swap_sent(0, U128(50_000_000), Ok(U128(0)));
    assert_eq!(unused, U128(50_000_000));
    assert!(router.get_pending(0).is_none());
}

#[test]
fn partial_use_is_failure_and_returns_the_rest() {
    let mut router = router_with_pending();
    callback_context();
    let unused = router.on_swap_sent(0, U128(50_000_000), Ok(U128(20_000_000)));
    assert_eq!(unused, U128(30_000_000));
    assert!(router.get_pending(0).is_none());
}

#[test]
fn failed_dex_call_returns_full_usdc_and_drops_pending() {
    let mut router = router_with_pending();
    callback_context();
    let unused = router.on_swap_sent(0, U128(50_000_000), Err(PromiseError::Failed));
    assert_eq!(unused, U128(50_000_000));
    assert!(router.get_pending(0).is_none());
    assert!(get_logs().iter().any(|l| l.contains("swap_failed")));
}

#[test]
fn failure_callback_is_harmless_when_pending_is_gone() {
    let mut router = new_router();
    callback_context();
    let unused = router.on_swap_sent(9, U128(5), Err(PromiseError::Failed));
    assert_eq!(unused, U128(5));
}

// ─── Step 4/5: DEX -> router -> arena ────────────────────────────────────

#[test]
fn dex_coin_is_forwarded_to_arena_and_pending_removed() {
    let mut router = router_with_pending();
    set_context("pepe", 0);
    let result = router.ft_on_transfer(acc("dex"), U128(200), r#"{"swap_id":0}"#.to_string());
    assert_eq!(value(result), 0);
    assert!(router.get_pending(0).is_none());

    let calls = calls();
    assert_eq!(calls.len(), 2);
    let (receiver, method, args) = &calls[0];
    assert_eq!(receiver, &acc("pepe"));
    assert_eq!(method, "ft_transfer_call");
    assert_eq!(args["receiver_id"], "arena.testnet");
    assert_eq!(args["amount"], "200");
    let msg: Value = serde_json::from_str(args["msg"].as_str().unwrap()).unwrap();
    assert_eq!(msg["action"], "deposit");
    assert_eq!(msg["beneficiary"], "alice.testnet");
    assert_eq!(msg["usdc_equiv"], "50000000");
    assert_eq!(msg["from_credit"], "35000000");
    assert_eq!(calls[1].1, "on_deposit_sent");
}

#[test]
fn swap_id_cannot_be_used_twice() {
    let mut router = router_with_pending();
    set_context("pepe", 0);
    let first = router.ft_on_transfer(acc("dex"), U128(200), r#"{"swap_id":0}"#.to_string());
    assert_eq!(value(first), 0);
    set_context("pepe", 0);
    let second = router.ft_on_transfer(acc("dex"), U128(200), r#"{"swap_id":0}"#.to_string());
    assert_eq!(value(second), 200);
    assert!(calls().is_empty());
}

#[test]
fn coin_from_anyone_but_the_dex_is_returned() {
    let mut router = router_with_pending();
    set_context("pepe", 0);
    let result = router.ft_on_transfer(acc("stranger"), U128(200), r#"{"swap_id":0}"#.to_string());
    assert_eq!(value(result), 200);
    assert!(router.get_pending(0).is_some());
}

#[test]
fn wrong_token_from_dex_is_returned_and_pending_kept() {
    let mut router = router_with_pending();
    set_context("shib", 0);
    let result = router.ft_on_transfer(acc("dex"), U128(200), r#"{"swap_id":0}"#.to_string());
    assert_eq!(value(result), 200);
    assert!(router.get_pending(0).is_some());
    assert!(calls().is_empty());
}

#[test]
fn output_below_minimum_is_returned_and_pending_kept() {
    let mut router = router_with_pending();
    set_context("pepe", 0);
    let result = router.ft_on_transfer(acc("dex"), U128(122), r#"{"swap_id":0}"#.to_string());
    assert_eq!(value(result), 122);
    assert!(router.get_pending(0).is_some());
    assert!(calls().is_empty());
}

#[test]
fn output_equal_to_minimum_is_accepted() {
    let mut router = router_with_pending();
    set_context("pepe", 0);
    let result = router.ft_on_transfer(acc("dex"), U128(123), r#"{"swap_id":0}"#.to_string());
    assert_eq!(value(result), 0);
}

#[test]
fn unknown_swap_id_and_bad_receipts_are_returned() {
    let mut router = router_with_pending();
    for msg in [r#"{"swap_id":99}"#, r#"{"swap_id":"x"}"#, "{}", "junk"] {
        set_context("pepe", 0);
        let result = router.ft_on_transfer(acc("dex"), U128(200), msg.to_string());
        assert_eq!(value(result), 200, "msg {msg}");
    }
    assert!(router.get_pending(0).is_some());
}

// ─── Step 5 callback: arena result and stranded accounting ──────────────

#[test]
fn arena_accepting_all_strands_nothing() {
    let mut router = new_router();
    callback_context();
    router.on_deposit_sent(acc("alice"), acc("pepe"), U128(200), Ok(U128(200)));
    assert_eq!(router.get_stranded(acc("alice"), acc("pepe")), U128(0));
}

#[test]
fn arena_rejecting_strands_the_whole_coin() {
    let mut router = new_router();
    callback_context();
    router.on_deposit_sent(acc("alice"), acc("pepe"), U128(200), Ok(U128(0)));
    assert_eq!(router.get_stranded(acc("alice"), acc("pepe")), U128(200));
}

#[test]
fn partial_arena_use_strands_the_rest() {
    let mut router = new_router();
    callback_context();
    router.on_deposit_sent(acc("alice"), acc("pepe"), U128(200), Ok(U128(150)));
    assert_eq!(router.get_stranded(acc("alice"), acc("pepe")), U128(50));
}

#[test]
fn failed_arena_call_strands_the_whole_coin() {
    let mut router = new_router();
    callback_context();
    router.on_deposit_sent(
        acc("alice"),
        acc("pepe"),
        U128(200),
        Err(PromiseError::Failed),
    );
    assert_eq!(router.get_stranded(acc("alice"), acc("pepe")), U128(200));
}

#[test]
fn stranded_balances_accumulate_per_account_and_token() {
    let mut router = new_router();
    callback_context();
    router.on_deposit_sent(acc("alice"), acc("pepe"), U128(10), Ok(U128(0)));
    router.on_deposit_sent(acc("alice"), acc("pepe"), U128(5), Ok(U128(0)));
    router.on_deposit_sent(acc("alice"), acc("shib"), U128(7), Ok(U128(0)));
    router.on_deposit_sent(acc("bob"), acc("pepe"), U128(3), Ok(U128(0)));
    assert_eq!(router.get_stranded(acc("alice"), acc("pepe")), U128(15));
    assert_eq!(router.get_stranded(acc("alice"), acc("shib")), U128(7));
    assert_eq!(router.get_stranded(acc("bob"), acc("pepe")), U128(3));
}

// ─── claim_stranded ──────────────────────────────────────────────────────

fn router_with_stranded() -> Router {
    let mut router = new_router();
    callback_context();
    router.on_deposit_sent(acc("alice"), acc("pepe"), U128(200), Ok(U128(0)));
    router
}

#[test]
fn claim_pays_out_and_clears_balance() {
    let mut router = router_with_stranded();
    set_context("alice", 1);
    let _ = router.claim_stranded(acc("pepe"));
    assert_eq!(router.get_stranded(acc("alice"), acc("pepe")), U128(0));

    let calls = calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].0, acc("pepe"));
    assert_eq!(calls[0].1, "ft_transfer");
    assert_eq!(calls[0].2["receiver_id"], "alice.testnet");
    assert_eq!(calls[0].2["amount"], "200");
    assert_eq!(calls[1].1, "on_claim_paid");
}

#[test]
#[should_panic(expected = "Nothing stranded")]
fn second_claim_panics() {
    let mut router = router_with_stranded();
    set_context("alice", 1);
    let _ = router.claim_stranded(acc("pepe"));
    set_context("alice", 1);
    let _ = router.claim_stranded(acc("pepe"));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn claim_requires_one_yocto() {
    let mut router = router_with_stranded();
    set_context("alice", 0);
    let _ = router.claim_stranded(acc("pepe"));
}

#[test]
#[should_panic(expected = "Nothing stranded")]
fn claim_without_balance_panics() {
    let mut router = router_with_stranded();
    set_context("bob", 1);
    let _ = router.claim_stranded(acc("pepe"));
}

#[test]
#[should_panic(expected = "Nothing stranded")]
fn claim_for_other_token_panics() {
    let mut router = router_with_stranded();
    set_context("alice", 1);
    let _ = router.claim_stranded(acc("shib"));
}

#[test]
fn failed_payout_restores_balance() {
    let mut router = new_router();
    callback_context();
    router.on_claim_paid(
        acc("alice"),
        acc("pepe"),
        U128(200),
        Err(PromiseError::Failed),
    );
    assert_eq!(router.get_stranded(acc("alice"), acc("pepe")), U128(200));
    assert!(get_logs().iter().any(|l| l.contains("claim_failed")));
}

#[test]
fn successful_payout_leaves_balance_cleared() {
    let mut router = new_router();
    callback_context();
    router.on_claim_paid(acc("alice"), acc("pepe"), U128(200), Ok(()));
    assert_eq!(router.get_stranded(acc("alice"), acc("pepe")), U128(0));
    assert!(get_logs().iter().any(|l| l.contains("stranded_claimed")));
}

// ─── End to end at unit level ────────────────────────────────────────────

#[test]
fn slippage_failure_returns_full_usdc_and_leaves_no_state() {
    let mut router = router_with_pending();
    callback_context();
    let unused = router.on_swap_sent(0, U128(50_000_000), Ok(U128(0)));
    assert_eq!(unused, U128(50_000_000));
    assert!(router.get_pending(0).is_none());
    assert_eq!(router.get_stranded(acc("alice"), acc("pepe")), U128(0));
}

#[test]
fn rejected_deposit_after_swap_leaves_coin_claimable_only() {
    let mut router = router_with_pending();
    set_context("pepe", 0);
    let _ = router.ft_on_transfer(acc("dex"), U128(200), r#"{"swap_id":0}"#.to_string());
    callback_context();
    router.on_deposit_sent(acc("alice"), acc("pepe"), U128(200), Ok(U128(0)));
    assert!(router.get_pending(0).is_none());
    assert_eq!(router.get_stranded(acc("alice"), acc("pepe")), U128(200));
}
