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
