use super::*;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

fn acc(name: &str) -> AccountId {
    format!("{name}.testnet").parse().unwrap()
}

fn set_context(predecessor: &str) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("adapter"))
        .predecessor_account_id(acc(predecessor))
        .build());
}

fn adapter() -> RefAdapter {
    set_context("owner");
    RefAdapter::new(acc("owner"), acc("ref"))
}

#[test]
fn owner_routes_a_pair_in_both_directions() {
    let mut a = adapter();
    a.set_pool(acc("usdc"), acc("pepe"), 2897);
    assert_eq!(a.get_pool(acc("usdc"), acc("pepe")), Some(2897));
    assert_eq!(a.get_pool(acc("pepe"), acc("usdc")), Some(2897));
    assert_eq!(a.get_pool(acc("usdc"), acc("shib")), None);
}

#[test]
#[should_panic(expected = "Only the owner")]
fn stranger_cannot_set_a_pool() {
    let mut a = adapter();
    set_context("stranger");
    a.set_pool(acc("usdc"), acc("pepe"), 1);
}

#[test]
#[should_panic(expected = "Tokens must differ")]
fn a_pool_needs_two_tokens() {
    let mut a = adapter();
    a.set_pool(acc("usdc"), acc("usdc"), 1);
}

#[test]
#[should_panic(expected = "Only the owner")]
fn stranger_cannot_change_the_exchange() {
    let mut a = adapter();
    set_context("stranger");
    a.set_exchange(acc("other"));
}

#[test]
fn new_adapter_is_idle() {
    let a = adapter();
    assert_eq!(a.get_exchange(), acc("ref"));
    assert!(a.get_inflight().is_none());
    assert_eq!(a.get_held(acc("pepe")), U128(0));
}

#[test]
fn ref_message_has_the_shape_ref_expects() {
    let msg = msgs::ref_swap_msg(2897, &acc("usdc"), &acc("pepe"), 10_000_000, 5);
    let v: Value = serde_json::from_str(&msg).unwrap();
    assert_eq!(v["force"], 0);
    let action = &v["actions"][0];
    assert_eq!(action["pool_id"], 2897);
    assert_eq!(action["token_in"], "usdc.testnet");
    assert_eq!(action["token_out"], "pepe.testnet");
    assert_eq!(action["amount_in"], "10000000");
    assert_eq!(action["min_amount_out"], "5");
}

#[test]
fn ref_message_never_asks_for_a_zero_minimum() {
    let msg = msgs::ref_swap_msg(1, &acc("usdc"), &acc("pepe"), 100, 0);
    let v: Value = serde_json::from_str(&msg).unwrap();
    assert_eq!(v["actions"][0]["min_amount_out"], "1");
}

#[test]
fn caller_message_parses_like_the_mock_dex_one() {
    let msg = r#"{"action":"swap","token_out":"pepe.testnet","min_amount_out":"7","receiver_id":"router.testnet","receiver_msg":"{\"swap_id\":3}"}"#;
    match msgs::parse_transfer_msg(msg) {
        Some(msgs::TransferMsg::Swap {
            token_out,
            min_amount_out,
            receiver_id,
            receiver_msg,
        }) => {
            assert_eq!(token_out, acc("pepe"));
            assert_eq!(min_amount_out, U128(7));
            assert_eq!(receiver_id, acc("router"));
            assert_eq!(receiver_msg, "{\"swap_id\":3}");
        }
        None => panic!("message did not parse"),
    }
    assert!(msgs::parse_transfer_msg("not json").is_none());
}

// ─── Swap flow ───────────────────────────────────────────────────────────

use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs};

fn routed() -> RefAdapter {
    let mut a = adapter();
    a.set_pool(acc("usdc"), acc("pepe"), 2897);
    a
}

fn swap_msg(min_out: &str) -> String {
    json!({
        "action": "swap",
        "token_out": "pepe.testnet",
        "min_amount_out": min_out,
        "receiver_id": "router.testnet",
        "receiver_msg": "{\"swap_id\":7}",
    })
    .to_string()
}

fn start(a: &mut RefAdapter, amount: u128, min_out: &str) -> PromiseOrValue<U128> {
    set_context("usdc");
    a.ft_on_transfer(acc("router"), U128(amount), swap_msg(min_out))
}

fn returned(result: PromiseOrValue<U128>) -> u128 {
    match result {
        PromiseOrValue::Value(v) => v.0,
        PromiseOrValue::Promise(_) => panic!("expected a value"),
    }
}

fn is_promise(result: &PromiseOrValue<U128>) -> bool {
    matches!(result, PromiseOrValue::Promise(_))
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

fn logged(event: &str) -> bool {
    get_logs()
        .iter()
        .any(|l| l.contains(&format!("\"event\":\"{event}\"")))
}

#[test]
fn swap_is_forwarded_to_ref_with_the_floor() {
    let mut a = routed();
    let result = start(&mut a, 10_000_000, "9000");
    assert!(is_promise(&result));
    // A returned promise is only scheduled once it is dropped.
    drop(result);
    let swap = a.get_inflight().unwrap();
    assert_eq!(swap.amount_in, U128(10_000_000));
    assert!(!swap.measuring);
    let sent = calls();
    let transfer = sent
        .iter()
        .find(|(to, method, _)| *to == acc("usdc") && method == "ft_transfer_call")
        .expect("ft_transfer_call to the coin");
    assert_eq!(transfer.2["receiver_id"], "ref.testnet");
    let ref_msg: Value = serde_json::from_str(transfer.2["msg"].as_str().unwrap()).unwrap();
    assert_eq!(ref_msg["actions"][0]["pool_id"], 2897);
    assert_eq!(ref_msg["actions"][0]["min_amount_out"], "9000");
    assert!(sent
        .iter()
        .any(|(to, m, _)| *to == acc("adapter") && m == "on_ref_swap"));
}

#[test]
fn unrouted_pair_is_refunded() {
    let mut a = adapter();
    assert_eq!(returned(start(&mut a, 5_000, "1")), 5_000);
    assert!(a.get_inflight().is_none());
    assert!(logged("swap_refused"));
}

#[test]
fn second_swap_is_refused_while_one_runs() {
    let mut a = routed();
    assert!(is_promise(&start(&mut a, 5_000, "1")));
    assert_eq!(returned(start(&mut a, 7_000, "1")), 7_000);
    assert_eq!(a.get_inflight().unwrap().amount_in, U128(5_000));
}

#[test]
fn zero_amount_and_foreign_messages_are_returned() {
    let mut a = routed();
    assert_eq!(returned(start(&mut a, 0, "1")), 0);
    set_context("usdc");
    let out = a.ft_on_transfer(acc("router"), U128(40), "hello".to_string());
    assert_eq!(returned(out), 40);
    assert!(a.get_inflight().is_none());
}

#[test]
fn refund_from_ref_hands_the_input_back() {
    let mut a = routed();
    let _ = start(&mut a, 10_000_000, "9000");
    set_context("adapter");
    assert_eq!(a.on_ref_swap(Ok(U128(0))), U128(10_000_000));
    assert!(a.get_inflight().is_none());
    assert!(logged("swap_failed"));
}

#[test]
fn failed_call_to_ref_hands_the_input_back() {
    let mut a = routed();
    let _ = start(&mut a, 10_000_000, "9000");
    set_context("adapter");
    assert_eq!(a.on_ref_swap(Err(PromiseError::Failed)), U128(10_000_000));
    assert!(a.get_inflight().is_none());
}

#[test]
fn accepted_swap_waits_for_the_measurement() {
    let mut a = routed();
    let _ = start(&mut a, 10_000_000, "9000");
    set_context("adapter");
    assert_eq!(a.on_ref_swap(Ok(U128(10_000_000))), U128(0));
    assert!(a.get_inflight().unwrap().measuring);
    assert!(calls()
        .iter()
        .any(|(to, m, _)| *to == acc("pepe") && m == "ft_balance_of"));
}

fn measuring(amount_in: u128, min_out: &str) -> RefAdapter {
    let mut a = routed();
    let _ = start(&mut a, amount_in, min_out);
    set_context("adapter");
    let _ = a.on_ref_swap(Ok(U128(amount_in)));
    a
}

#[test]
fn measured_output_is_paid_to_the_receiver() {
    let mut a = measuring(10_000_000, "9000");
    set_context("adapter");
    a.on_measured(Ok(U128(9_871)));
    assert!(a.get_inflight().is_none());
    assert_eq!(a.get_held(acc("pepe")), U128(0));
    let payout = calls()
        .into_iter()
        .find(|(to, m, _)| *to == acc("pepe") && m == "ft_transfer_call")
        .expect("payout");
    assert_eq!(payout.2["receiver_id"], "router.testnet");
    assert_eq!(payout.2["amount"], "9871");
    assert_eq!(payout.2["msg"], "{\"swap_id\":7}");
}

#[test]
fn earlier_leftovers_are_not_paid_out() {
    let mut a = routed();
    a.held.insert(acc("pepe"), 500);
    let _ = start(&mut a, 10_000_000, "9000");
    set_context("adapter");
    let _ = a.on_ref_swap(Ok(U128(10_000_000)));
    a.on_measured(Ok(U128(10_371)));
    assert_eq!(a.get_held(acc("pepe")), U128(500));
    let payout = calls()
        .into_iter()
        .find(|(to, m, _)| *to == acc("pepe") && m == "ft_transfer_call")
        .unwrap();
    assert_eq!(payout.2["amount"], "9871");
}

#[test]
fn output_below_the_floor_is_not_paid() {
    let mut a = measuring(10_000_000, "9000");
    set_context("adapter");
    a.on_measured(Ok(U128(100)));
    assert!(a.get_inflight().is_none());
    assert_eq!(a.get_held(acc("pepe")), U128(100));
    assert!(logged("output_short"));
    assert!(!calls()
        .iter()
        .any(|(to, m, _)| *to == acc("pepe") && m == "ft_transfer_call"));
}

#[test]
fn failed_measurement_keeps_the_swap_and_can_be_retried() {
    let mut a = measuring(10_000_000, "9000");
    set_context("adapter");
    a.on_measured(Err(PromiseError::Failed));
    assert!(a.get_inflight().unwrap().measuring);
    assert!(logged("measure_failed"));
    set_context("stranger");
    a.retry_measure();
    assert!(calls()
        .iter()
        .any(|(to, m, _)| *to == acc("pepe") && m == "ft_balance_of"));
}

#[test]
#[should_panic(expected = "No swap is waiting")]
fn retry_needs_a_waiting_swap() {
    let mut a = routed();
    set_context("stranger");
    a.retry_measure();
}

#[test]
fn rejected_payout_is_kept_for_the_owner() {
    let mut a = routed();
    set_context("adapter");
    a.on_payout(acc("pepe"), U128(9_871), Ok(U128(0)));
    assert_eq!(a.get_held(acc("pepe")), U128(9_871));
    a.on_payout(acc("pepe"), U128(100), Ok(U128(100)));
    assert_eq!(a.get_held(acc("pepe")), U128(9_871));
    a.on_payout(acc("pepe"), U128(10), Err(PromiseError::Failed));
    assert_eq!(a.get_held(acc("pepe")), U128(9_881));
}

#[test]
fn owner_withdraws_held_coin() {
    let mut a = routed();
    a.held.insert(acc("pepe"), 1_000);
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("adapter"))
        .predecessor_account_id(acc("owner"))
        .attached_deposit(NearToken::from_yoctonear(1))
        .build());
    a.withdraw_held(acc("pepe"), acc("owner"), U128(400));
    assert_eq!(a.get_held(acc("pepe")), U128(600));
    assert!(calls()
        .iter()
        .any(|(to, m, _)| *to == acc("pepe") && m == "ft_transfer"));
}

#[test]
#[should_panic(expected = "Amount exceeds the held balance")]
fn cannot_withdraw_more_than_held() {
    let mut a = routed();
    a.held.insert(acc("pepe"), 10);
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("adapter"))
        .predecessor_account_id(acc("owner"))
        .attached_deposit(NearToken::from_yoctonear(1))
        .build());
    a.withdraw_held(acc("pepe"), acc("owner"), U128(11));
}

#[test]
#[should_panic(expected = "Only the owner")]
fn stranger_cannot_withdraw_held_coin() {
    let mut a = routed();
    a.held.insert(acc("pepe"), 10);
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("adapter"))
        .predecessor_account_id(acc("stranger"))
        .attached_deposit(NearToken::from_yoctonear(1))
        .build());
    a.withdraw_held(acc("pepe"), acc("stranger"), U128(1));
}

#[test]
fn owner_clears_a_stuck_swap() {
    let mut a = routed();
    let _ = start(&mut a, 5_000, "1");
    set_context("owner");
    a.clear_inflight();
    assert!(a.get_inflight().is_none());
}

#[test]
#[should_panic(expected = "Only the owner")]
fn stranger_cannot_clear_a_swap() {
    let mut a = routed();
    set_context("stranger");
    a.clear_inflight();
}
