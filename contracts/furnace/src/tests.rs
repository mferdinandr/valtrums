use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

fn acc(name: &str) -> AccountId {
    format!("{name}.testnet").parse().unwrap()
}

fn as_token(token: &str) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("furnace"))
        .predecessor_account_id(acc(token))
        .build());
}

fn burn(f: &mut Furnace, token: &str, sender: &str, amount: u128, msg: &str) -> u128 {
    as_token(token);
    match f.ft_on_transfer(acc(sender), U128(amount), msg.to_string()) {
        PromiseOrValue::Value(v) => v.0,
        PromiseOrValue::Promise(_) => panic!("the furnace never returns a promise"),
    }
}

fn furnace() -> Furnace {
    as_token("deployer");
    Furnace::new()
}

fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|b| serde_json::from_str::<Value>(b).unwrap())
        .collect()
}

#[test]
fn every_coin_is_kept_in_full() {
    let mut f = furnace();
    assert_eq!(
        burn(&mut f, "pepe", "arena", 2_000, r#"{"battle_id":7}"#),
        0
    );
    assert_eq!(burn(&mut f, "never-seen", "someone", 500, ""), 0);
    assert_eq!(burn(&mut f, "pepe", "someone", 1, "not json at all"), 0);
}

#[test]
fn a_battle_burn_is_recorded_by_coin_battle_and_sender() {
    let mut f = furnace();
    burn(&mut f, "pepe", "arena", 2_000, r#"{"battle_id":7}"#);
    assert_eq!(f.get_total(acc("pepe")), U128(2_000));
    assert_eq!(
        f.get_battle_burns(7),
        vec![CoinBurn {
            token_id: acc("pepe"),
            burned: U128(2_000)
        }]
    );
    assert_eq!(f.get_sender_total(acc("pepe"), acc("arena")), U128(2_000));
    let e = events();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["standard"], "furnace");
    assert_eq!(e[0]["event"], "furnace_burned");
    assert_eq!(e[0]["data"][0]["token_id"], "pepe.testnet");
    assert_eq!(e[0]["data"][0]["amount"], "2000");
    assert_eq!(e[0]["data"][0]["sender_id"], "arena.testnet");
    assert_eq!(e[0]["data"][0]["battle_id"], 7);
}

#[test]
fn a_burn_without_a_battle_only_moves_the_totals() {
    let mut f = furnace();
    burn(&mut f, "pepe", "fan", 100, "");
    assert_eq!(f.get_total(acc("pepe")), U128(100));
    assert!(f.get_battle_burns(0).is_empty());
    assert_eq!(f.get_sender_total(acc("pepe"), acc("fan")), U128(100));
    assert!(events()[0]["data"][0]["battle_id"].is_null());
}

#[test]
fn messages_that_do_not_name_a_battle_count_as_no_battle() {
    let mut f = furnace();
    burn(&mut f, "pepe", "fan", 1, "{}");
    burn(&mut f, "pepe", "fan", 1, r#"{"battle_id":"7"}"#);
    burn(&mut f, "pepe", "fan", 1, r#"{"other":1}"#);
    assert_eq!(f.get_total(acc("pepe")), U128(3));
    assert!(f.get_battle_burns(7).is_empty());
}

#[test]
fn totals_accumulate_across_battles_and_coins() {
    let mut f = furnace();
    burn(&mut f, "pepe", "arena", 2_000, r#"{"battle_id":1}"#);
    burn(&mut f, "shib", "arena", 40, r#"{"battle_id":2}"#);
    burn(&mut f, "pepe", "arena", 1_000, r#"{"battle_id":3}"#);
    burn(&mut f, "pepe", "arena", 5, r#"{"battle_id":3}"#);
    assert_eq!(f.get_total(acc("pepe")), U128(3_005));
    assert_eq!(f.get_total(acc("shib")), U128(40));
    assert_eq!(f.get_battle_burns(3)[0].burned, U128(1_005));
    assert_eq!(f.get_battle_burns(3).len(), 1);
    assert_eq!(f.get_coin_count(), 2);
    assert_eq!(
        f.get_coins(0, 10),
        vec![
            CoinBurn {
                token_id: acc("pepe"),
                burned: U128(3_005)
            },
            CoinBurn {
                token_id: acc("shib"),
                burned: U128(40)
            },
        ]
    );
}

#[test]
fn one_battle_can_burn_several_coins() {
    let mut f = furnace();
    burn(&mut f, "pepe", "arena", 10, r#"{"battle_id":9}"#);
    burn(&mut f, "shib", "arena", 20, r#"{"battle_id":9}"#);
    let coins: Vec<_> = f
        .get_battle_burns(9)
        .into_iter()
        .map(|c| c.token_id)
        .collect();
    assert_eq!(coins, vec![acc("pepe"), acc("shib")]);
}

#[test]
fn zero_amounts_record_nothing() {
    let mut f = furnace();
    assert_eq!(burn(&mut f, "pepe", "fan", 0, r#"{"battle_id":1}"#), 0);
    assert_eq!(f.get_coin_count(), 0);
    assert!(events().is_empty());
}

#[test]
fn coin_pages_are_capped_and_offset() {
    let mut f = furnace();
    for i in 0..150 {
        burn(&mut f, &format!("coin{i}"), "fan", 1, "");
    }
    assert_eq!(f.get_coin_count(), 150);
    assert_eq!(f.get_coins(0, 1_000).len(), MAX_PAGE as usize);
    let tail = f.get_coins(140, 100);
    assert_eq!(tail.len(), 10);
    assert_eq!(tail[0].token_id, acc("coin140"));
    assert!(f.get_coins(500, 10).is_empty());
}

#[test]
fn totals_saturate_instead_of_overflowing() {
    let mut f = furnace();
    burn(&mut f, "pepe", "fan", u128::MAX, "");
    burn(&mut f, "pepe", "fan", 5, "");
    assert_eq!(f.get_total(acc("pepe")), U128(u128::MAX));
}
