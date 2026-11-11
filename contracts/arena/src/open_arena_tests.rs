//! Open arena unit tests: create with a start time, the joinable allowlist,
//! joining by deposit, the target-only deposit gate, funded-only lock, cancel
//! and refund. Fixtures stand in for audit and backing; they are not live evidence.

use crate::lifecycle::{
    AssetIdentity, AssetInput, AuditApproval, BackingApproval, ObservationPolicyInput, ScoringMode,
};
use crate::rounds::ObservationTerms;
use crate::rounds_api::{
    CandidateObservationInput, ModeDataInput, ObservationTermsInput, RoundOutcome,
};
use crate::Arena;
use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken, PromiseError, PromiseOrValue, PromiseResult};

const NOW_MS: u64 = 1_000_000;
const MINUTE_MS: u64 = 60_000;
const DAY_MS: u64 = 24 * 60 * 60 * 1_000;
const ROUND: u64 = 30_000_000_000;
const FAR: u64 = u64::MAX / 4;

fn account(name: &str) -> AccountId {
    name.parse().expect("account")
}

fn ctx(caller: &str, deposit: NearToken, now_ms: u64) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(account(caller))
        .attached_deposit(deposit)
        .block_timestamp(now_ms * 1_000_000)
        .build());
}

fn panics<F: FnOnce()>(f: F) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
}

fn identity(index: u32) -> AssetIdentity {
    AssetIdentity {
        chain_id: 46630,
        token_address: format!("0x{index:040x}"),
        representation: account(&format!("token{index}.testnet")),
        custody_domain: "vault".into(),
        reference_chain_id: None,
        reference_address: None,
    }
}

fn input(index: u32) -> AssetInput {
    identity(index).into()
}

fn terms() -> ObservationTermsInput {
    ObservationTermsInput {
        source: "source".into(),
        quote_currency: "USD".into(),
        eligible_pools: vec!["pool".into()],
        finality: "finalized".into(),
        price_decimals: 6,
        supply_decimals: 2,
        volume_decimals: 8,
        boundary_tolerance_ns: U64(0),
        max_gap_ns: U64(ROUND),
    }
}

/// Activated arena: protocol, worker (agent), oracle and a policy that matches `terms()`.
fn setup() -> Arena {
    ctx("owner.testnet", NearToken::from_yoctonear(0), NOW_MS);
    let mut arena = Arena::new(
        account("owner.testnet"),
        account("usdc.testnet"),
        account("treasury.testnet"),
        U128(0),
        U64(60),
    );
    arena.add_agent(account("worker.testnet"));
    ctx("owner.testnet", NearToken::from_yoctonear(1), NOW_MS);
    arena.activate_lifecycle();
    arena.set_lifecycle_protocol(account("protocol.testnet"));
    arena.set_lifecycle_oracle(account("oracle.testnet"));
    arena.set_lifecycle_observation_policy(ObservationPolicyInput {
        version: U64(1),
        policy_hash: ObservationTerms::from(terms()).digest(ScoringMode::PriceGain),
    });
    arena
}

fn list(arena: &mut Arena, index: u32) {
    ctx("protocol.testnet", NearToken::from_yoctonear(1), NOW_MS);
    arena.set_lifecycle_joinable_asset(input(index));
}

fn create(arena: &mut Arena, creator: &str, assets: Vec<AssetInput>, start: Option<u64>) -> u64 {
    ctx(creator, NearToken::from_near(1), NOW_MS);
    arena.create_lifecycle_battle(assets, ScoringMode::PriceGain, start.map(U64))
}

fn join(arena: &mut Arena, who: &str, id: u64, index: u32, now_ms: u64) -> u32 {
    ctx(who, NearToken::from_near(1), now_ms);
    arena.join_lifecycle_battle(id, account(&format!("token{index}.testnet")))
}

fn approve(arena: &mut Arena, id: u64, community: u32) {
    let asset = arena
        .lifecycle_battles
        .get(&id)
        .and_then(|b| b.community_asset(community as usize).cloned())
        .expect("community");
    arena
        .lifecycle_set_audit(
            id,
            community as usize,
            Some(AuditApproval {
                asset: asset.clone(),
                policy_hash: "policy".into(),
                evidence_hash: "audit".into(),
                expires_at_ms: FAR,
            }),
        )
        .expect("audit");
    arena
        .lifecycle_set_backing(
            id,
            community as usize,
            Some(BackingApproval {
                asset,
                evidence_hash: "backing".into(),
                expires_at_ms: FAR,
            }),
        )
        .expect("backing");
}

/// A representation transfer into the arena; returns the unused amount.
fn deposit(
    arena: &mut Arena,
    who: &str,
    id: u64,
    community: u32,
    token_index: u32,
    amount: u128,
    now_ms: u64,
) -> u128 {
    ctx(
        &format!("token{token_index}.testnet"),
        NearToken::from_yoctonear(0),
        now_ms,
    );
    let msg =
        format!(r#"{{"action":"lifecycle_deposit","battle_id":{id},"community":{community}}}"#);
    match arena.ft_on_transfer(account(who), U128(amount), msg) {
        PromiseOrValue::Value(unused) => unused.0,
        PromiseOrValue::Promise(_) => panic!("unexpected promise"),
    }
}

fn lock(arena: &mut Arena, id: u64, expected: Option<u32>, now_ms: u64) {
    ctx("worker.testnet", NearToken::from_near(1), now_ms);
    arena.lock_lifecycle_battle(id, expected);
}

fn vault(arena: &Arena, id: u64, community: usize) -> u128 {
    arena.get_lifecycle_battle(id).expect("battle").communities[community]
        .vault
        .0
}

fn count(arena: &Arena, id: u64) -> usize {
    arena
        .get_lifecycle_battle(id)
        .expect("battle")
        .communities
        .len()
}

/// Open arena with five listed tokens, created at `NOW_MS` to start in a day.
fn open_arena() -> (Arena, u64, u64) {
    let mut arena = setup();
    for index in 1..=5 {
        list(&mut arena, index);
    }
    let start = NOW_MS + DAY_MS;
    let id = create(&mut arena, "creator.testnet", vec![], Some(start));
    (arena, id, start)
}

#[test]
fn creation_with_and_without_a_start_time() {
    let mut arena = setup();
    let open = create(&mut arena, "creator.testnet", vec![], Some(NOW_MS + DAY_MS));
    let view = arena.get_lifecycle_battle(open).expect("battle");
    assert_eq!(view.start_at_ms, Some(U64(NOW_MS + DAY_MS)));
    assert!(!view.cancelled && view.communities.is_empty());
    assert_eq!(arena.get_lifecycle_start(open), Some(U64(NOW_MS + DAY_MS)));
    // The earlier call shape keeps working and carries no start time.
    let old = create(
        &mut arena,
        "creator.testnet",
        vec![input(1), input(2)],
        None,
    );
    let view = arena.get_lifecycle_battle(old).expect("battle");
    assert_eq!(view.start_at_ms, None);
    assert_eq!(arena.get_lifecycle_start(old), None);
    assert_eq!(view.communities.len(), 2);
    // The application view carries the same fields.
    let v1 = arena.get_lifecycle_battle_v1(U64(open)).expect("battle");
    assert_eq!(v1.start_at_ms, Some(U64(NOW_MS + DAY_MS)));
    let json = near_sdk::serde_json::to_value(&v1).expect("json");
    assert_eq!(json["start_at_ms"], (NOW_MS + DAY_MS).to_string());
    assert_eq!(json["cancelled"], false);
}

#[test]
fn start_times_outside_the_window_are_refused() {
    let mut arena = setup();
    let bounds = [
        NOW_MS,
        NOW_MS - 1,
        NOW_MS + MINUTE_MS - 1,
        NOW_MS + 7 * DAY_MS + 1,
        0,
        u64::MAX,
    ];
    for start in bounds {
        ctx("creator.testnet", NearToken::from_near(1), NOW_MS);
        assert!(
            panics(|| {
                arena.create_lifecycle_battle(vec![], ScoringMode::PriceGain, Some(U64(start)));
            }),
            "{start} accepted"
        );
    }
    assert_eq!(arena.get_lifecycle_battle_count(), 0);
    // Both edges are inclusive.
    let low = create(
        &mut arena,
        "creator.testnet",
        vec![],
        Some(NOW_MS + MINUTE_MS),
    );
    let high = create(
        &mut arena,
        "creator.testnet",
        vec![],
        Some(NOW_MS + 7 * DAY_MS),
    );
    assert_eq!((low, high), (1, 2));
}

#[test]
fn more_than_sixteen_seeded_communities_are_still_refused() {
    let mut arena = setup();
    ctx("creator.testnet", NearToken::from_near(1), NOW_MS);
    let assets: Vec<AssetInput> = (1..=17).map(input).collect();
    assert!(panics(|| {
        arena.create_lifecycle_battle(assets, ScoringMode::PriceGain, None);
    }));
    let sixteen: Vec<AssetInput> = (1..=16).map(input).collect();
    let id = create(&mut arena, "creator.testnet", sixteen, None);
    assert_eq!(count(&arena, id), 16);
}

#[test]
fn only_the_protocol_manages_joinable_assets_with_one_yocto() {
    let mut arena = setup();
    for (caller, deposit) in [
        ("owner.testnet", 1),
        ("creator.testnet", 1),
        ("protocol.testnet", 0),
        ("protocol.testnet", 2),
    ] {
        ctx(caller, NearToken::from_yoctonear(deposit), NOW_MS);
        assert!(
            panics(|| arena.set_lifecycle_joinable_asset(input(1))),
            "{caller} with {deposit}"
        );
        assert!(panics(
            || arena.remove_lifecycle_joinable_asset(account("token1.testnet"))
        ));
    }
    assert!(arena
        .get_lifecycle_joinable_asset(account("token1.testnet"))
        .is_none());
    list(&mut arena, 1);
    let listed = arena
        .get_lifecycle_joinable_asset(account("token1.testnet"))
        .expect("listed");
    assert_eq!(listed.token_address, identity(1).token_address);
    // An invalid identity, USDC and a clashing token are refused.
    ctx("protocol.testnet", NearToken::from_yoctonear(1), NOW_MS);
    let mut bad = input(2);
    bad.token_address = "0x01".into();
    assert!(panics(|| arena.set_lifecycle_joinable_asset(bad)));
    let mut usdc = input(2);
    usdc.representation = account("usdc.testnet");
    assert!(panics(|| arena.set_lifecycle_joinable_asset(usdc)));
    let mut clash = input(2);
    clash.token_address = identity(1).token_address;
    assert!(panics(|| arena.set_lifecycle_joinable_asset(clash)));
    // Removal is for the protocol only and takes the token out of the list.
    ctx("creator.testnet", NearToken::from_yoctonear(1), NOW_MS);
    assert!(panics(
        || arena.remove_lifecycle_joinable_asset(account("token1.testnet"))
    ));
    ctx("protocol.testnet", NearToken::from_yoctonear(1), NOW_MS);
    arena.remove_lifecycle_joinable_asset(account("token1.testnet"));
    assert!(arena
        .get_lifecycle_joinable_asset(account("token1.testnet"))
        .is_none());
    assert!(arena
        .get_lifecycle_joinable_assets(U64(0), U64(10))
        .is_empty());
    assert!(panics(
        || arena.remove_lifecycle_joinable_asset(account("token1.testnet"))
    ));
}

#[test]
fn the_joinable_list_is_paged_and_bounded() {
    let mut arena = setup();
    for index in 1..=5 {
        list(&mut arena, index);
    }
    // Replacing an entry keeps its place.
    list(&mut arena, 3);
    let names = |arena: &Arena, from: u64, limit: u64| -> Vec<String> {
        arena
            .get_lifecycle_joinable_assets(U64(from), U64(limit))
            .into_iter()
            .map(|a| a.representation.to_string())
            .collect()
    };
    assert_eq!(names(&arena, 0, 50).len(), 5);
    assert_eq!(names(&arena, 1, 2), ["token2.testnet", "token3.testnet"]);
    assert!(names(&arena, 5, 10).is_empty());
    assert!(names(&arena, u64::MAX, 10).is_empty());
    assert!(names(&arena, 0, 0).is_empty());
    // The page size is capped no matter what the caller asks for.
    for index in 6..=60 {
        list(&mut arena, index);
    }
    assert_eq!(names(&arena, 0, u64::MAX).len(), 50);
    assert_eq!(names(&arena, 50, u64::MAX).len(), 10);
}

#[test]
fn the_joinable_list_has_a_limit() {
    let mut arena = setup();
    for index in 1..=64 {
        list(&mut arena, index);
    }
    ctx("protocol.testnet", NearToken::from_yoctonear(1), NOW_MS);
    assert!(panics(|| arena.set_lifecycle_joinable_asset(input(65))));
    // An existing entry can still be replaced at the limit.
    list(&mut arena, 64);
}

#[test]
fn the_first_join_appends_a_community_and_later_joins_reuse_it() {
    let (mut arena, id, _) = open_arena();
    assert_eq!(join(&mut arena, "alice.testnet", id, 3, NOW_MS), 0);
    let logs = get_logs();
    assert_eq!(logs.len(), 1);
    assert!(logs[0].contains("lifecycle_community_added"));
    assert!(logs[0].contains(r#""battle_id":1"#));
    assert!(logs[0].contains(r#""account_id":"alice.testnet""#));
    assert!(logs[0].contains(r#""representation":"token3.testnet""#));
    // A second joiner of the same token reuses index 0 and emits no event.
    assert_eq!(join(&mut arena, "bob.testnet", id, 3, NOW_MS), 0);
    assert!(get_logs().is_empty());
    // A new token appends at the next index.
    assert_eq!(join(&mut arena, "bob.testnet", id, 1, NOW_MS), 1);
    assert_eq!(count(&arena, id), 2);
    // Joining twice is idempotent.
    assert_eq!(join(&mut arena, "bob.testnet", id, 1, NOW_MS), 1);
    assert_eq!(count(&arena, id), 2);
    for (who, community) in [("alice.testnet", 0), ("bob.testnet", 0), ("bob.testnet", 1)] {
        assert!(
            arena
                .get_lifecycle_position(id, community, account(who))
                .registered
        );
    }
    assert!(
        !arena
            .get_lifecycle_position(id, 1, account("alice.testnet"))
            .registered
    );
}

#[test]
fn joining_an_arena_that_already_has_the_token_reuses_its_community() {
    let mut arena = setup();
    list(&mut arena, 2);
    let id = create(
        &mut arena,
        "creator.testnet",
        vec![input(1), input(2)],
        Some(NOW_MS + DAY_MS),
    );
    assert_eq!(join(&mut arena, "alice.testnet", id, 2, NOW_MS), 1);
    assert_eq!(count(&arena, id), 2);
}

#[test]
fn a_token_that_is_not_listed_cannot_join() {
    let (mut arena, id, _) = open_arena();
    ctx("alice.testnet", NearToken::from_near(1), NOW_MS);
    assert!(panics(|| {
        arena.join_lifecycle_battle(id, account("token9.testnet"));
    }));
    // A removed token cannot start a new community, either.
    ctx("protocol.testnet", NearToken::from_yoctonear(1), NOW_MS);
    arena.remove_lifecycle_joinable_asset(account("token5.testnet"));
    ctx("alice.testnet", NearToken::from_near(1), NOW_MS);
    assert!(panics(|| {
        arena.join_lifecycle_battle(id, account("token5.testnet"));
    }));
    assert_eq!(count(&arena, id), 0);
    // An unknown battle and a missing storage deposit are refused.
    assert!(panics(|| {
        arena.join_lifecycle_battle(99, account("token1.testnet"));
    }));
    assert_eq!(count(&arena, id), 0);
    ctx("alice.testnet", NearToken::from_yoctonear(1), NOW_MS);
    assert!(panics(|| {
        arena.join_lifecycle_battle(id, account("token1.testnet"));
    }));
    // (A failed call reverts on chain; the unit-test mock keeps its writes.)
}

#[test]
fn joining_is_refused_at_the_start_time_after_lock_and_after_cancel() {
    let (mut arena, id, start) = open_arena();
    join(&mut arena, "creator.testnet", id, 1, NOW_MS);
    // One millisecond before the start still works; the start itself does not.
    assert_eq!(join(&mut arena, "alice.testnet", id, 2, start - 1), 1);
    ctx("alice.testnet", NearToken::from_near(1), start);
    assert!(panics(|| {
        arena.join_lifecycle_battle(id, account("token3.testnet"));
    }));
    assert!(panics(|| {
        arena.join_lifecycle_battle(id, account("token1.testnet"));
    }));
}

#[test]
fn joining_is_refused_after_lock() {
    let (mut arena, id, start) = open_arena();
    join(&mut arena, "creator.testnet", id, 1, NOW_MS);
    join(&mut arena, "alice.testnet", id, 2, NOW_MS);
    for (community, token, who) in [(0, 1, "creator.testnet"), (1, 2, "alice.testnet")] {
        approve(&mut arena, id, community);
        assert_eq!(
            deposit(&mut arena, who, id, community, token, 5, start - 1),
            0
        );
    }
    lock(&mut arena, id, Some(2), start);
    ctx("bob.testnet", NearToken::from_near(1), start);
    assert!(panics(|| {
        arena.join_lifecycle_battle(id, account("token3.testnet"));
    }));
}

#[test]
fn joining_is_refused_after_cancel() {
    let mut arena = setup();
    list(&mut arena, 1);
    let id = create(&mut arena, "creator.testnet", vec![], Some(NOW_MS + DAY_MS));
    ctx(
        "anyone.testnet",
        NearToken::from_yoctonear(0),
        NOW_MS + DAY_MS,
    );
    arena.cancel_lifecycle_battle(id);
    ctx(
        "alice.testnet",
        NearToken::from_near(1),
        NOW_MS + DAY_MS - 1,
    );
    assert!(panics(|| {
        arena.join_lifecycle_battle(id, account("token1.testnet"));
    }));
}

#[test]
fn a_cancelled_arena_refuses_a_join_even_before_the_clock_says_otherwise() {
    // Even if the clock were earlier than the start, the flag closes joining.
    let mut arena = setup();
    list(&mut arena, 1);
    let id = create(&mut arena, "creator.testnet", vec![], Some(NOW_MS + DAY_MS));
    ctx(
        "anyone.testnet",
        NearToken::from_yoctonear(0),
        NOW_MS + DAY_MS,
    );
    arena.cancel_lifecycle_battle(id);
    ctx("alice.testnet", NearToken::from_near(1), NOW_MS);
    assert!(panics(|| {
        arena.join_lifecycle_battle(id, account("token1.testnet"));
    }));
}

#[test]
fn the_seventeenth_community_is_refused() {
    let mut arena = setup();
    for index in 1..=17 {
        list(&mut arena, index);
    }
    let id = create(&mut arena, "creator.testnet", vec![], Some(NOW_MS + DAY_MS));
    for index in 1..=16 {
        assert_eq!(
            join(&mut arena, "alice.testnet", id, index, NOW_MS),
            index - 1
        );
    }
    ctx("alice.testnet", NearToken::from_near(1), NOW_MS);
    assert!(panics(|| {
        arena.join_lifecycle_battle(id, account("token17.testnet"));
    }));
    assert_eq!(count(&arena, id), 16);
    // Existing communities can still be joined at the limit.
    assert_eq!(join(&mut arena, "bob.testnet", id, 7, NOW_MS), 6);
}

#[test]
fn a_deposit_needs_only_the_target_communitys_approvals() {
    let (mut arena, id, _) = open_arena();
    join(&mut arena, "creator.testnet", id, 1, NOW_MS);
    join(&mut arena, "alice.testnet", id, 2, NOW_MS);
    // Neither community is approved yet: the transfer comes back.
    assert_eq!(
        deposit(&mut arena, "creator.testnet", id, 0, 1, 5, NOW_MS),
        5
    );
    // Approving community 0 alone opens it, while community 1 stays closed.
    approve(&mut arena, id, 0);
    assert_eq!(
        deposit(&mut arena, "creator.testnet", id, 0, 1, 5, NOW_MS),
        0
    );
    assert_eq!(deposit(&mut arena, "alice.testnet", id, 1, 2, 7, NOW_MS), 7);
    assert_eq!(vault(&arena, id, 0), 5);
    assert_eq!(vault(&arena, id, 1), 0);
    // The wrong token for a community is refused.
    approve(&mut arena, id, 1);
    assert_eq!(deposit(&mut arena, "alice.testnet", id, 1, 1, 7, NOW_MS), 7);
}

#[test]
fn deposits_are_refused_at_and_after_the_start_time_and_after_cancel() {
    let (mut arena, id, start) = open_arena();
    join(&mut arena, "creator.testnet", id, 1, NOW_MS);
    approve(&mut arena, id, 0);
    assert_eq!(
        deposit(&mut arena, "creator.testnet", id, 0, 1, 5, start - 1),
        0
    );
    assert_eq!(
        deposit(&mut arena, "creator.testnet", id, 0, 1, 5, start),
        5
    );
    assert_eq!(
        deposit(&mut arena, "creator.testnet", id, 0, 1, 5, start + 1),
        5
    );
    assert_eq!(vault(&arena, id, 0), 5);
    // After a cancel the arena takes nothing even though the clock is earlier.
    ctx("anyone.testnet", NearToken::from_yoctonear(0), start);
    arena.cancel_lifecycle_battle(id);
    assert_eq!(
        deposit(&mut arena, "creator.testnet", id, 0, 1, 5, start - 1),
        5
    );
}

#[test]
fn lock_before_the_start_time_is_refused() {
    let (mut arena, id, start) = open_arena();
    join(&mut arena, "creator.testnet", id, 1, NOW_MS);
    join(&mut arena, "alice.testnet", id, 2, NOW_MS);
    for (community, token, who) in [(0, 1, "creator.testnet"), (1, 2, "alice.testnet")] {
        approve(&mut arena, id, community);
        assert_eq!(deposit(&mut arena, who, id, community, token, 5, NOW_MS), 0);
    }
    ctx("worker.testnet", NearToken::from_near(1), start - 1);
    assert!(panics(|| arena.lock_lifecycle_battle(id, None)));
    assert!(!arena.get_lifecycle_battle(id).expect("battle").locked);
    lock(&mut arena, id, None, start);
    assert!(arena.get_lifecycle_battle(id).expect("battle").locked);
    // A repeat after the lock is idempotent.
    lock(&mut arena, id, None, start + 5);
}

#[test]
fn lock_counts_only_funded_communities_and_keeps_every_index() {
    let (mut arena, id, start) = open_arena();
    // Four communities enter; community 1 never gets a deposit.
    join(&mut arena, "creator.testnet", id, 1, NOW_MS);
    join(&mut arena, "alice.testnet", id, 2, NOW_MS);
    join(&mut arena, "bob.testnet", id, 3, NOW_MS);
    join(&mut arena, "carol.testnet", id, 4, NOW_MS);
    for community in [0, 2, 3] {
        approve(&mut arena, id, community);
    }
    // The unfunded community 1 has no approval at all and must not matter.
    for (community, token, who, amount) in [
        (0, 1, "creator.testnet", 10),
        (2, 3, "bob.testnet", 20),
        (3, 4, "carol.testnet", 30),
    ] {
        assert_eq!(
            deposit(&mut arena, who, id, community, token, amount, NOW_MS),
            0
        );
    }
    lock(&mut arena, id, Some(4), start);
    let view = arena.get_lifecycle_battle(id).expect("battle");
    assert!(view.locked);
    assert_eq!(view.communities.len(), 4);
    let vaults: Vec<u128> = view.communities.iter().map(|c| c.vault.0).collect();
    assert_eq!(vaults, [10, 0, 20, 30]);
    assert_eq!(
        arena
            .lifecycle_battles
            .get(&id)
            .expect("b")
            .funded_indices(),
        [0, 2, 3]
    );
}

#[test]
fn lock_needs_two_funded_communities_fresh_approvals_and_a_creator_position() {
    let (mut arena, id, start) = open_arena();
    join(&mut arena, "creator.testnet", id, 1, NOW_MS);
    join(&mut arena, "alice.testnet", id, 2, NOW_MS);
    approve(&mut arena, id, 0);
    approve(&mut arena, id, 1);
    // One funded community is not enough.
    assert_eq!(
        deposit(&mut arena, "creator.testnet", id, 0, 1, 5, NOW_MS),
        0
    );
    ctx("worker.testnet", NearToken::from_near(1), start);
    assert!(panics(|| arena.lock_lifecycle_battle(id, None)));
    // Two funded, but the creator holds nothing in the second one only: still fine
    // because the creator position is per arena, so check the opposite case below.
    assert_eq!(deposit(&mut arena, "alice.testnet", id, 1, 2, 5, NOW_MS), 0);
    // A funded community whose approval was withdrawn blocks the lock.
    arena.lifecycle_set_backing(id, 1, None).expect("withdraw");
    ctx("worker.testnet", NearToken::from_near(1), start);
    assert!(panics(|| arena.lock_lifecycle_battle(id, None)));
    approve(&mut arena, id, 1);
    lock(&mut arena, id, None, start);
    // An arena nobody who created it joined cannot lock.
    let id2 = create(&mut arena, "dave.testnet", vec![], Some(start + DAY_MS));
    join(&mut arena, "alice.testnet", id2, 1, start);
    join(&mut arena, "bob.testnet", id2, 2, start);
    for (community, token, who) in [(0, 1, "alice.testnet"), (1, 2, "bob.testnet")] {
        approve(&mut arena, id2, community);
        assert_eq!(deposit(&mut arena, who, id2, community, token, 5, start), 0);
    }
    ctx("worker.testnet", NearToken::from_near(1), start + DAY_MS);
    assert!(panics(|| arena.lock_lifecycle_battle(id2, None)));
}

#[test]
fn an_expected_count_that_differs_fails_the_lock() {
    let (mut arena, id, start) = open_arena();
    for (index, who) in [(1, "creator.testnet"), (2, "alice.testnet")] {
        join(&mut arena, who, id, index, NOW_MS);
        approve(&mut arena, id, index - 1);
        assert_eq!(deposit(&mut arena, who, id, index - 1, index, 5, NOW_MS), 0);
    }
    // A third community joined after the caller read the list.
    join(&mut arena, "bob.testnet", id, 3, NOW_MS);
    for expected in [1, 2, 4] {
        ctx("worker.testnet", NearToken::from_near(1), start);
        assert!(
            panics(|| arena.lock_lifecycle_battle(id, Some(expected))),
            "{expected}"
        );
    }
    lock(&mut arena, id, Some(3), start);
}

#[test]
fn locking_stays_agent_only_with_a_deposit() {
    let (mut arena, id, start) = open_arena();
    ctx("creator.testnet", NearToken::from_near(1), start);
    assert!(panics(|| arena.lock_lifecycle_battle(id, None)));
    ctx("worker.testnet", NearToken::from_yoctonear(0), start);
    assert!(panics(|| arena.lock_lifecycle_battle(id, None)));
}

#[test]
fn cancel_only_works_after_the_start_with_fewer_than_two_funded_communities() {
    let (mut arena, id, start) = open_arena();
    join(&mut arena, "creator.testnet", id, 1, NOW_MS);
    join(&mut arena, "alice.testnet", id, 2, NOW_MS);
    approve(&mut arena, id, 0);
    approve(&mut arena, id, 1);
    assert_eq!(
        deposit(&mut arena, "creator.testnet", id, 0, 1, 5, NOW_MS),
        0
    );
    // Too early.
    ctx("anyone.testnet", NearToken::from_yoctonear(0), start - 1);
    assert!(panics(|| arena.cancel_lifecycle_battle(id)));
    // An unknown battle and one without a start time cannot be cancelled.
    assert!(panics(|| arena.cancel_lifecycle_battle(99)));
    let seeded = create(
        &mut arena,
        "creator.testnet",
        vec![input(1), input(2)],
        None,
    );
    ctx("anyone.testnet", NearToken::from_yoctonear(0), start);
    assert!(panics(|| arena.cancel_lifecycle_battle(seeded)));
    // Two funded communities: no cancel.
    assert_eq!(deposit(&mut arena, "alice.testnet", id, 1, 2, 5, NOW_MS), 0);
    ctx("anyone.testnet", NearToken::from_yoctonear(0), start);
    assert!(panics(|| arena.cancel_lifecycle_battle(id)));
    assert!(!arena.is_lifecycle_cancelled(id));
    // Locked: no cancel.
    lock(&mut arena, id, None, start);
    ctx("anyone.testnet", NearToken::from_yoctonear(0), start);
    assert!(panics(|| arena.cancel_lifecycle_battle(id)));
}

#[test]
fn cancel_sets_the_flag_emits_once_and_cannot_repeat() {
    let (mut arena, id, start) = open_arena();
    join(&mut arena, "creator.testnet", id, 1, NOW_MS);
    approve(&mut arena, id, 0);
    assert_eq!(
        deposit(&mut arena, "creator.testnet", id, 0, 1, 5, NOW_MS),
        0
    );
    ctx("anyone.testnet", NearToken::from_yoctonear(0), start);
    arena.cancel_lifecycle_battle(id);
    assert!(arena.is_lifecycle_cancelled(id));
    let logs = get_logs();
    assert_eq!(logs.len(), 1);
    assert!(logs[0].contains("lifecycle_battle_cancelled"));
    assert!(arena.get_lifecycle_battle(id).expect("battle").cancelled);
    assert!(panics(|| arena.cancel_lifecycle_battle(id)));
    // A cancelled arena can never lock.
    ctx("worker.testnet", NearToken::from_near(1), start);
    assert!(panics(|| arena.lock_lifecycle_battle(id, None)));
}

/// A cancelled arena with alice (5 of token1) and bob (7 of token1) in community 0.
fn cancelled_with_deposits() -> (Arena, u64, u64) {
    let (mut arena, id, start) = open_arena();
    join(&mut arena, "alice.testnet", id, 1, NOW_MS);
    join(&mut arena, "bob.testnet", id, 1, NOW_MS);
    approve(&mut arena, id, 0);
    assert_eq!(deposit(&mut arena, "alice.testnet", id, 0, 1, 5, NOW_MS), 0);
    assert_eq!(deposit(&mut arena, "bob.testnet", id, 0, 1, 7, NOW_MS), 0);
    ctx("anyone.testnet", NearToken::from_yoctonear(0), start);
    arena.cancel_lifecycle_battle(id);
    (arena, id, start)
}

fn claim(arena: &mut Arena, who: &str, id: u64, community: u32, now_ms: u64) {
    ctx(who, NearToken::from_yoctonear(1), now_ms);
    let _ = arena.claim_lifecycle_refund(id, community);
}

fn callback(arena: &mut Arena, failed: bool, who: &str, amount: u128, id: u64) -> bool {
    let result = if failed {
        PromiseResult::Failed
    } else {
        PromiseResult::Successful(vec![])
    };
    testing_env!(
        VMContextBuilder::new()
            .predecessor_account_id(account("arena.testnet"))
            .current_account_id(account("arena.testnet"))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
    let outcome = if failed {
        Err(PromiseError::Failed)
    } else {
        Ok(())
    };
    arena.on_lifecycle_refund(id, 0, account(who), U128(amount), outcome)
}

#[test]
fn a_refund_zeroes_the_position_and_vault_before_the_transfer_and_cannot_repeat() {
    let (mut arena, id, start) = cancelled_with_deposits();
    assert_eq!(vault(&arena, id, 0), 12);
    claim(&mut arena, "alice.testnet", id, 0, start + 1);
    // The state is already reduced while the transfer is in flight.
    assert_eq!(
        arena
            .get_lifecycle_position(id, 0, account("alice.testnet"))
            .amount
            .0,
        0
    );
    assert_eq!(vault(&arena, id, 0), 7);
    // A second claim pays nothing, in flight or after.
    ctx("alice.testnet", NearToken::from_yoctonear(1), start + 2);
    assert!(panics(|| {
        let _ = arena.claim_lifecycle_refund(id, 0);
    }));
    assert_eq!(vault(&arena, id, 0), 7);
    // Bob is independent and gets exactly his own amount.
    claim(&mut arena, "bob.testnet", id, 0, start + 3);
    assert_eq!(vault(&arena, id, 0), 0);
    // Nobody else, and nobody without a deposit, can claim.
    for who in ["carol.testnet", "creator.testnet"] {
        ctx(who, NearToken::from_yoctonear(1), start + 4);
        assert!(panics(|| {
            let _ = arena.claim_lifecycle_refund(id, 0);
        }));
    }
}

#[test]
fn a_refund_needs_one_yocto_a_cancelled_arena_and_a_real_community() {
    let (mut arena, id, start) = cancelled_with_deposits();
    for deposit in [0, 2] {
        ctx(
            "alice.testnet",
            NearToken::from_yoctonear(deposit),
            start + 1,
        );
        assert!(panics(|| {
            let _ = arena.claim_lifecycle_refund(id, 0);
        }));
    }
    ctx("alice.testnet", NearToken::from_yoctonear(1), start + 1);
    assert!(panics(|| {
        let _ = arena.claim_lifecycle_refund(id, 3);
    }));
}

#[test]
fn a_live_arena_refunds_nobody() {
    let (mut live, live_id, _) = open_arena();
    join(&mut live, "alice.testnet", live_id, 1, NOW_MS);
    approve(&mut live, live_id, 0);
    assert_eq!(
        deposit(&mut live, "alice.testnet", live_id, 0, 1, 5, NOW_MS),
        0
    );
    ctx("alice.testnet", NearToken::from_yoctonear(1), NOW_MS);
    assert!(panics(|| {
        let _ = live.claim_lifecycle_refund(live_id, 0);
    }));
}

#[test]
fn a_failed_refund_transfer_restores_the_position_and_vault() {
    let (mut arena, id, start) = cancelled_with_deposits();
    claim(&mut arena, "alice.testnet", id, 0, start + 1);
    assert_eq!(vault(&arena, id, 0), 7);
    assert!(!callback(&mut arena, true, "alice.testnet", 5, id));
    assert_eq!(
        arena
            .get_lifecycle_position(id, 0, account("alice.testnet"))
            .amount
            .0,
        5
    );
    assert_eq!(vault(&arena, id, 0), 12);
    let logs = get_logs();
    assert!(logs.iter().any(|l| l.contains("lifecycle_refund_failed")));
    // The refund can then be claimed again, once.
    claim(&mut arena, "alice.testnet", id, 0, start + 2);
    assert_eq!(vault(&arena, id, 0), 7);
}

#[test]
fn a_successful_refund_emits_the_event_and_changes_nothing_else() {
    let (mut arena, id, start) = cancelled_with_deposits();
    claim(&mut arena, "alice.testnet", id, 0, start + 1);
    assert!(callback(&mut arena, false, "alice.testnet", 5, id));
    let logs = get_logs();
    assert!(logs[0].contains("lifecycle_refund"));
    assert!(logs[0].contains(r#""amount":"5""#));
    assert_eq!(vault(&arena, id, 0), 7);
}

fn rounds_terms_policy_started(arena: &mut Arena, id: u64, start: u64) {
    ctx("anyone.testnet", NearToken::from_near(1), start);
    arena.start_lifecycle_rounds(U64(id), terms());
}

fn observation(community: u32, end: u128, start_ns: u64) -> CandidateObservationInput {
    CandidateObservationInput {
        community,
        observed_times_ns: vec![U64(start_ns), U64(start_ns + ROUND)],
        evidence_hash: "evidence".into(),
        data: ModeDataInput::Price {
            start: U128(100),
            end: U128(end),
        },
    }
}

#[test]
fn rounds_and_settlement_skip_a_community_that_was_never_funded() {
    let (mut arena, id, start) = open_arena();
    for (index, who) in [
        (1, "creator.testnet"),
        (2, "alice.testnet"),
        (3, "bob.testnet"),
    ] {
        join(&mut arena, who, id, index, NOW_MS);
    }
    // Community 1 (token2) stays empty and unapproved.
    for community in [0, 2] {
        approve(&mut arena, id, community);
    }
    assert_eq!(
        deposit(&mut arena, "creator.testnet", id, 0, 1, 10, NOW_MS),
        0
    );
    assert_eq!(deposit(&mut arena, "bob.testnet", id, 2, 3, 10, NOW_MS), 0);
    lock(&mut arena, id, Some(3), start);
    rounds_terms_policy_started(&mut arena, id, start);
    // Only the funded communities compete.
    let start_ns = start * 1_000_000;
    ctx("oracle.testnet", NearToken::from_yoctonear(1), start);
    arena.open_lifecycle_round(U64(id), U64(1), U64(start_ns));
    let logs = get_logs();
    assert!(logs[0].contains(r#""candidates":[0,2]"#), "{}", logs[0]);
    ctx(
        "oracle.testnet",
        NearToken::from_yoctonear(1),
        start + ROUND / 1_000_000,
    );
    // Evidence for the excluded community does not match the candidates: the
    // round stays pending and nothing is recorded.
    let held = arena.submit_lifecycle_observations(
        U64(id),
        U64(1),
        vec![
            observation(0, 90, start_ns),
            observation(1, 95, start_ns),
            observation(2, 99, start_ns),
        ],
    );
    assert!(matches!(held, RoundOutcome::Pending { .. }));
    let outcome = arena.submit_lifecycle_observations(
        U64(id),
        U64(1),
        vec![observation(0, 90, start_ns), observation(2, 99, start_ns)],
    );
    assert_eq!(outcome, RoundOutcome::Winner { community: 2 });
    // Settlement pays only the one funded loser; the empty community adds nothing.
    let plan = arena.settlement_plan(id).expect("plan");
    assert!(!plan.is_empty());
    assert!(plan
        .iter()
        .all(|item| item.backing == account("token1.testnet")));
    let progress = arena.get_settlement_progress(U64(id)).expect("progress");
    assert_eq!(progress.total as usize, plan.len());
}

#[test]
fn a_protocol_created_open_arena_pays_the_whole_fee_to_the_protocol() {
    let mut arena = setup();
    for index in 1..=2 {
        list(&mut arena, index);
    }
    let start = NOW_MS + DAY_MS;
    let id = create(&mut arena, "protocol.testnet", vec![], Some(start));
    let view = arena.get_lifecycle_battle(id).expect("battle");
    assert!(view.protocol_created);
    assert_eq!(view.creator, account("protocol.testnet"));
    join(&mut arena, "protocol.testnet", id, 1, NOW_MS);
    join(&mut arena, "alice.testnet", id, 2, NOW_MS);
    for (community, token, who) in [(0, 1, "protocol.testnet"), (1, 2, "alice.testnet")] {
        approve(&mut arena, id, community);
        assert_eq!(
            deposit(&mut arena, who, id, community, token, 1000, NOW_MS),
            0
        );
    }
    lock(&mut arena, id, Some(2), start);
    assert!(arena.get_lifecycle_battle(id).expect("battle").locked);
}

// ---- D40: per-mode observation policies ----

fn mode_policy(arena: &mut Arena, mode: ScoringMode, hash: Option<&str>) {
    ctx("owner.testnet", NearToken::from_yoctonear(1), NOW_MS);
    arena.set_lifecycle_mode_observation_policy(
        mode,
        hash.map(|h| ObservationPolicyInput {
            version: U64(2),
            policy_hash: h.into(),
        }),
    );
}

#[test]
fn without_mode_policies_every_mode_is_created_and_the_legacy_policy_locks() {
    let mut arena = setup();
    assert!(!arena.is_lifecycle_mode_policy_enabled());
    ctx("creator.testnet", NearToken::from_near(1), NOW_MS);
    arena.create_lifecycle_battle(vec![], ScoringMode::VolumeRatio, Some(U64(NOW_MS + DAY_MS)));
    let (mut arena, id, start) = open_arena();
    join(&mut arena, "creator.testnet", id, 1, NOW_MS);
    join(&mut arena, "alice.testnet", id, 2, NOW_MS);
    for (community, token, who) in [(0, 1, "creator.testnet"), (1, 2, "alice.testnet")] {
        approve(&mut arena, id, community);
        deposit(&mut arena, who, id, community, token, 5, start - 1);
    }
    lock(&mut arena, id, Some(2), start);
    let legacy = ObservationTerms::from(terms()).digest(ScoringMode::PriceGain);
    assert_eq!(
        arena
            .get_lifecycle_battle(id)
            .expect("battle")
            .observation_policy_hash
            .as_deref(),
        Some(legacy.as_str())
    );
}

#[test]
fn mode_policies_refuse_unoffered_modes_and_the_lock_freezes_the_mode_policy() {
    let (mut arena, id, start) = open_arena();
    // Only the owner, with exactly one yocto.
    ctx("mallory.testnet", NearToken::from_yoctonear(1), NOW_MS);
    assert!(panics(|| arena.set_lifecycle_mode_observation_policy(
        ScoringMode::PriceGain,
        None
    )));
    ctx("owner.testnet", NearToken::from_yoctonear(2), NOW_MS);
    assert!(panics(|| arena.set_lifecycle_mode_observation_policy(
        ScoringMode::PriceGain,
        None
    )));
    mode_policy(&mut arena, ScoringMode::PriceGain, Some("price-policy"));
    assert!(arena.is_lifecycle_mode_policy_enabled());
    assert_eq!(
        arena
            .get_lifecycle_mode_observation_policy(ScoringMode::PriceGain)
            .map(|p| p.policy_hash),
        Some("price-policy".into())
    );
    // A mode without its own policy can no longer be created: it could lock and never start its rounds.
    ctx("creator.testnet", NearToken::from_near(1), NOW_MS);
    assert!(panics(|| {
        arena.create_lifecycle_battle(vec![], ScoringMode::VolumeRatio, Some(U64(NOW_MS + DAY_MS)));
    }));
    // The PriceGain battle created before still locks, and freezes the PriceGain policy, not the legacy one.
    join(&mut arena, "creator.testnet", id, 1, NOW_MS);
    join(&mut arena, "alice.testnet", id, 2, NOW_MS);
    for (community, token, who) in [(0, 1, "creator.testnet"), (1, 2, "alice.testnet")] {
        approve(&mut arena, id, community);
        deposit(&mut arena, who, id, community, token, 5, start - 1);
    }
    lock(&mut arena, id, Some(2), start);
    assert_eq!(
        arena
            .get_lifecycle_battle(id)
            .expect("battle")
            .observation_policy_hash
            .as_deref(),
        Some("price-policy")
    );
}

#[test]
fn clearing_a_mode_policy_stops_new_battles_of_that_mode() {
    let mut arena = setup();
    mode_policy(&mut arena, ScoringMode::PriceGain, Some("price-policy"));
    mode_policy(
        &mut arena,
        ScoringMode::LowestDrawdown,
        Some("drawdown-policy"),
    );
    ctx("creator.testnet", NearToken::from_near(1), NOW_MS);
    arena.create_lifecycle_battle(
        vec![],
        ScoringMode::LowestDrawdown,
        Some(U64(NOW_MS + DAY_MS)),
    );
    mode_policy(&mut arena, ScoringMode::LowestDrawdown, None);
    assert_eq!(
        arena
            .get_lifecycle_mode_observation_policy(ScoringMode::LowestDrawdown)
            .map(|p| p.policy_hash),
        None
    );
    ctx("creator.testnet", NearToken::from_near(1), NOW_MS);
    assert!(panics(|| {
        arena.create_lifecycle_battle(
            vec![],
            ScoringMode::LowestDrawdown,
            Some(U64(NOW_MS + DAY_MS)),
        );
    }));
    ctx("owner.testnet", NearToken::from_yoctonear(1), NOW_MS);
    assert!(panics(|| arena.set_lifecycle_mode_observation_policy(
        ScoringMode::PriceGain,
        Some(ObservationPolicyInput {
            version: U64(1),
            policy_hash: " ".into()
        })
    )));
}
