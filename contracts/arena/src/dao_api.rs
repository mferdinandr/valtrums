//! DAO vote on a battle's escrowed winning principal and its execution
//! (decision D22, design in `docs/dao-governance.md`).
//!
//! - The protocol account sets the vote window (1 minute to 30 days); each
//!   battle snapshots it at creation. A battle created without one has no vote
//!   and its principal stays escrowed.
//! - The window opens when the final winner is recorded. Only participants of
//!   the winning community vote, once each, with their snapshotted position as
//!   weight, choosing burn or return. There is no quorum and no delegation.
//! - After the window anyone may execute. With no vote cast the principal stays
//!   escrowed indefinitely. Otherwise the burn share of the weight cast applies
//!   to every holder: `burn_i = floor(p_i * B / (B + R))`, `return_i = p_i -
//!   burn_i`, so nothing is burned beyond what was voted and the parts add up
//!   to the escrow exactly. Returns become entitlements of each winner in the
//!   backing; the burn becomes one disposal reservation to the backing's frozen
//!   sink. Each release has a deterministic id and is recorded at most once.
//! - Only the contract's own tally decides; no owner, worker or oracle method
//!   can create, change or veto a decision. A burn counts as done only when the
//!   backing confirms a finalized debit to the sink (see `get_escrow_disposition`
//!   on the backing); destroying NEAR representations is not that evidence.
use crate::escrow_api::escrow_id;
use crate::math::mul_div_floor;
use crate::settle_api::ENTITLEMENT_DEPOSIT;
use crate::settlement::part;
use crate::{events, Arena, ArenaExt};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue,
};

const NS_PER_SECOND: u64 = 1_000_000_000;
/// Bounds of the protocol-adjustable vote window (owner decision for #75).
pub const MIN_DAO_WINDOW_SECS: u64 = 60;
pub const MAX_DAO_WINDOW_SECS: u64 = 30 * 24 * 60 * 60;
const RELEASE_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
/// Keeps `MAX_BATCH * RELEASE_GAS + CALLBACK_GAS` well inside one transaction.
const MAX_BATCH: u32 = 10;

#[ext_contract(ext_backing_dao)]
#[allow(dead_code)]
trait BackingDao {
    fn release_escrow_return(
        &mut self,
        escrow_id: [u8; 32],
        release_id: [u8; 32],
        beneficiary: AccountId,
        amount: U128,
    ) -> bool;
    fn release_escrow_burn(
        &mut self,
        escrow_id: [u8; 32],
        release_id: [u8; 32],
        amount: U128,
    ) -> bool;
}

/// One release of the decided disposition.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Release {
    Return {
        beneficiary: AccountId,
        amount: u128,
    },
    Burn {
        amount: u128,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedRelease {
    pub id: [u8; 32],
    pub release: Release,
}

/// Deterministic release identity bound to this arena, the battle and the
/// release's position in the fixed plan order.
pub fn release_id(arena: &AccountId, battle_id: u64, index: u32) -> [u8; 32] {
    let mut data = b"valtrum/dao-release/v1".to_vec();
    part(&mut data, arena.as_str().as_bytes());
    part(&mut data, &battle_id.to_be_bytes());
    part(&mut data, &index.to_be_bytes());
    env::sha256_array(&data)
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DispositionStatus {
    /// No final winner yet.
    NoWinner,
    /// The battle was created without a vote window: principal stays escrowed.
    NoVote,
    Voting,
    /// The window closed with no vote cast: principal stays escrowed.
    UndecidedEscrowed,
    /// The window closed with votes; releases can be executed.
    Decided,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DispositionView {
    pub status: DispositionStatus,
    pub window_secs: Option<U64>,
    pub opens_at_ns: Option<U64>,
    pub closes_at_ns: Option<U64>,
    pub burn_weight: U128,
    pub return_weight: U128,
    /// True once the backing holds the principal in its escrow bucket.
    pub escrow_reserved: bool,
    pub escrow_id: Option<String>,
    /// Totals of the decided split (zero until decided).
    pub burn_total: U128,
    pub return_total: U128,
    /// Releases handed to the backing so far, out of `total_releases`. A burn
    /// release is a reservation for the sink, not a confirmed source burn.
    pub released: u32,
    pub total_releases: u32,
}

/// One decided release. `id` (hex) is the backing's release id; for the burn it
/// is also the `request_id` of the DAO burn reservation the payout executes.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseView {
    pub id: String,
    /// "return" or "burn".
    pub kind: String,
    pub beneficiary: Option<AccountId>,
    pub amount: U128,
    /// True once the backing recorded it; a recorded burn is a reservation for
    /// the sink, not a confirmed source burn.
    pub recorded: bool,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Arena {
    /// (opens, closes) of the battle's vote, when it has a window and a winner.
    fn dao_window(&self, id: u64) -> Option<(u64, u64)> {
        let window = *self.lifecycle_dao_windows.get(&id)?;
        let opens = *self.lifecycle_winner_at.get(&id)?;
        Some((opens, opens.checked_add(window)?))
    }

    /// The decided releases in a fixed order: each winner's return portion by
    /// registration order, then one burn of the summed burn portions.
    pub fn disposition_plan(&self, id: u64) -> Result<Vec<PlannedRelease>, &'static str> {
        let battle = self.lifecycle_battles.get(&id).ok_or("Unknown battle")?;
        let hold = battle.principal_hold().ok_or("No final winner")?;
        let (_, closes) = self.dao_window(id).ok_or("No vote for this battle")?;
        if env::block_timestamp() < closes {
            return Err("Vote is still open");
        }
        let (burn, keep) = self.lifecycle_dao_tally.get(&id).copied().unwrap_or((0, 0));
        let cast = burn.checked_add(keep).ok_or("Tally overflow")?;
        if cast == 0 {
            return Err("No vote cast: principal stays escrowed");
        }
        let holders = self.lifecycle_participant_positions(id, hold.community);
        let total = holders
            .iter()
            .try_fold(0u128, |sum, (_, amount)| sum.checked_add(*amount))
            .ok_or("Position overflow")?;
        if total != hold.amount {
            return Err("Positions do not match the escrowed principal");
        }
        let arena = env::current_account_id();
        let mut plan = Vec::new();
        let mut burn_total = 0u128;
        for (beneficiary, amount) in holders {
            let burned = mul_div_floor(amount, burn, cast).map_err(|_| "Split overflow")?;
            burn_total = burn_total.checked_add(burned).ok_or("Burn overflow")?;
            let returned = amount - burned;
            if returned > 0 {
                let index = u32::try_from(plan.len()).map_err(|_| "Too many releases")?;
                plan.push(PlannedRelease {
                    id: release_id(&arena, id, index),
                    release: Release::Return {
                        beneficiary,
                        amount: returned,
                    },
                });
            }
        }
        if burn_total > 0 {
            let index = u32::try_from(plan.len()).map_err(|_| "Too many releases")?;
            plan.push(PlannedRelease {
                id: release_id(&arena, id, index),
                release: Release::Burn { amount: burn_total },
            });
        }
        Ok(plan)
    }
}

#[near]
impl Arena {
    /// Protocol only, exactly one yocto. Sets the DAO vote window (1 minute to
    /// 30 days) that battles created afterwards snapshot. Existing battles keep
    /// theirs, so a change cannot shorten or extend a vote in progress.
    #[payable]
    pub fn set_lifecycle_dao_window(&mut self, window_secs: U64) {
        near_sdk::assert_one_yocto();
        require!(
            self.lifecycle_protocol.as_ref() == Some(&env::predecessor_account_id()),
            "Only the protocol account can change the DAO window"
        );
        require!(
            (MIN_DAO_WINDOW_SECS..=MAX_DAO_WINDOW_SECS).contains(&window_secs.0),
            "DAO window must be between 1 minute and 30 days"
        );
        self.lifecycle_dao_window_ns = Some(window_secs.0 * NS_PER_SECOND);
    }

    /// The window the next battle will snapshot, in seconds; None means no vote.
    pub fn get_lifecycle_dao_window(&self) -> Option<U64> {
        self.lifecycle_dao_window_ns
            .map(|ns| U64(ns / NS_PER_SECOND))
    }

    /// A participant of the final winning community votes once, inside the
    /// window, to burn (`burn = true`) or return their battle's principal. The
    /// weight is the caller's snapshotted position. Attach enough NEAR for the
    /// vote's storage; the rest is refunded.
    #[payable]
    pub fn vote_lifecycle_disposition(&mut self, battle_id: U64, burn: bool) {
        require!(!self.paused, "Arena is paused");
        let id = battle_id.0;
        let community = self
            .lifecycle_battles
            .get(&id)
            .and_then(|battle| battle.principal_hold())
            .map(|hold| hold.community)
            .unwrap_or_else(|| env::panic_str("No final winner"));
        let (opens, closes) = self
            .dao_window(id)
            .unwrap_or_else(|| env::panic_str("No vote for this battle"));
        let now = env::block_timestamp();
        require!(opens <= now && now < closes, "Vote is closed");
        let voter = env::predecessor_account_id();
        let weight = self.lifecycle_position(id, community, &voter);
        require!(weight > 0, "Only winning participants can vote");
        let key = (id, voter.clone());
        require!(
            self.lifecycle_dao_votes.get(&key).is_none(),
            "Already voted"
        );
        let (burned, kept) = self.lifecycle_dao_tally.get(&id).copied().unwrap_or((0, 0));
        let tally = if burn {
            (burned.checked_add(weight), Some(kept))
        } else {
            (Some(burned), kept.checked_add(weight))
        };
        let tally = match tally {
            (Some(burned), Some(kept)) => (burned, kept),
            _ => env::panic_str("Tally overflow"),
        };
        let before = env::storage_usage();
        self.lifecycle_dao_votes.insert(key, burn);
        self.lifecycle_dao_tally.insert(id, tally);
        self.lifecycle_dao_votes.flush();
        self.lifecycle_dao_tally.flush();
        let cost = env::storage_byte_cost()
            .as_yoctonear()
            .checked_mul(u128::from(env::storage_usage().saturating_sub(before)))
            .unwrap_or_else(|| env::panic_str("Storage cost overflow"));
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, "Insufficient storage deposit");
        if attached > cost {
            Promise::new(voter.clone())
                .transfer(NearToken::from_yoctonear(attached - cost))
                .detach();
        }
        events::emit(
            "dao_vote_cast",
            json!({
                "battle_id": battle_id,
                "voter": voter,
                "choice": if burn { "burn" } else { "return" },
                "weight": U128(weight),
            }),
        );
    }

    /// Permissionless after the window closes. Hands the next batch of decided
    /// releases to the winning token's backing; attach `ENTITLEMENT_DEPOSIT`
    /// for each (the rest is refunded). Needs the principal in the backing's
    /// escrow first (`reserve_lifecycle_escrow`). Returns releases recorded.
    #[payable]
    pub fn execute_lifecycle_disposition(
        &mut self,
        battle_id: U64,
        max_releases: u32,
    ) -> PromiseOrValue<u32> {
        require!(!self.paused, "Arena is paused");
        require!(
            (1..=MAX_BATCH).contains(&max_releases),
            "Batch size must be between 1 and 10"
        );
        let id = battle_id.0;
        require!(
            self.lifecycle_escrow.get(&id).copied() == Some(true),
            "Escrow not reserved"
        );
        let plan = self
            .disposition_plan(id)
            .unwrap_or_else(|reason| env::panic_str(&format!("Cannot execute: {reason}")));
        let hold = self
            .lifecycle_battles
            .get(&id)
            .and_then(|battle| battle.principal_hold().cloned())
            .unwrap_or_else(|| env::panic_str("No final winner"));
        let cursor = self.lifecycle_dao_progress.get(&id).copied().unwrap_or(0) as usize;
        let attached = env::attached_deposit();
        let caller = env::predecessor_account_id();
        if cursor >= plan.len() {
            if !attached.is_zero() {
                Promise::new(caller).transfer(attached).detach();
            }
            return PromiseOrValue::Value(plan.len() as u32);
        }
        let end = plan.len().min(cursor + max_releases as usize);
        let needed = ENTITLEMENT_DEPOSIT
            .as_yoctonear()
            .checked_mul((end - cursor) as u128)
            .unwrap_or_else(|| env::panic_str("Deposit overflow"));
        require!(
            attached.as_yoctonear() >= needed,
            "Insufficient disposition deposit"
        );
        if attached.as_yoctonear() > needed {
            Promise::new(caller)
                .transfer(NearToken::from_yoctonear(attached.as_yoctonear() - needed))
                .detach();
        }
        let escrow = escrow_id(&env::current_account_id(), id, hold.community);
        let mut joined: Option<Promise> = None;
        for item in &plan[cursor..end] {
            let backing = ext_backing_dao::ext(hold.asset.representation.clone())
                .with_static_gas(RELEASE_GAS)
                .with_attached_deposit(ENTITLEMENT_DEPOSIT);
            let call = match &item.release {
                Release::Return {
                    beneficiary,
                    amount,
                } => backing.release_escrow_return(
                    escrow,
                    item.id,
                    beneficiary.clone(),
                    U128(*amount),
                ),
                Release::Burn { amount } => {
                    backing.release_escrow_burn(escrow, item.id, U128(*amount))
                }
            };
            joined = Some(match joined {
                None => call,
                Some(previous) => previous.and(call),
            });
        }
        let joined = joined.unwrap_or_else(|| env::panic_str("Empty batch"));
        PromiseOrValue::Promise(
            joined.then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_disposition_batch(battle_id, cursor as u32, end as u32),
            ),
        )
    }

    /// Advance the cursor only when this batch started at the cursor and every
    /// backing call succeeded; otherwise the batch is simply repeated (the
    /// backing records each release id at most once).
    #[private]
    pub fn on_disposition_batch(&mut self, battle_id: U64, from: u32, to: u32) -> u32 {
        let all_succeeded = (0..env::promise_results_count())
            .all(|index| env::promise_result_checked(index, 8).is_ok());
        let current = self
            .lifecycle_dao_progress
            .get(&battle_id.0)
            .copied()
            .unwrap_or(0);
        if all_succeeded && current == from {
            self.lifecycle_dao_progress.insert(battle_id.0, to);
            events::emit(
                "dao_disposition_released",
                json!({ "battle_id": battle_id, "released": to }),
            );
            return to;
        }
        current
    }

    /// The decided releases in execution order; empty until the vote is decided.
    pub fn get_lifecycle_disposition_releases(&self, battle_id: U64) -> Vec<ReleaseView> {
        let recorded = self
            .lifecycle_dao_progress
            .get(&battle_id.0)
            .copied()
            .unwrap_or(0) as usize;
        self.disposition_plan(battle_id.0)
            .unwrap_or_default()
            .into_iter()
            .enumerate()
            .map(|(index, item)| {
                let (kind, beneficiary, amount) = match item.release {
                    Release::Return {
                        beneficiary,
                        amount,
                    } => ("return", Some(beneficiary), amount),
                    Release::Burn { amount } => ("burn", None, amount),
                };
                ReleaseView {
                    id: hex(&item.id),
                    kind: kind.to_string(),
                    beneficiary,
                    amount: U128(amount),
                    recorded: index < recorded,
                }
            })
            .collect()
    }

    /// Vote and execution state of a battle's winning principal; None for an
    /// unknown battle. Confirmed source disposition is reported by the backing.
    pub fn get_lifecycle_disposition(&self, battle_id: U64) -> Option<DispositionView> {
        let id = battle_id.0;
        let battle = self.lifecycle_battles.get(&id)?;
        let hold = battle.principal_hold();
        let window = self.lifecycle_dao_windows.get(&id).copied();
        let times = self.dao_window(id);
        let (burn, keep) = self.lifecycle_dao_tally.get(&id).copied().unwrap_or((0, 0));
        let status = match (hold, window, times) {
            (None, _, _) => DispositionStatus::NoWinner,
            (Some(_), None, _) => DispositionStatus::NoVote,
            (Some(_), Some(_), Some((_, closes))) if env::block_timestamp() < closes => {
                DispositionStatus::Voting
            }
            _ if burn.saturating_add(keep) == 0 => DispositionStatus::UndecidedEscrowed,
            _ => DispositionStatus::Decided,
        };
        let plan = if status == DispositionStatus::Decided {
            self.disposition_plan(id).unwrap_or_default()
        } else {
            Vec::new()
        };
        let (mut burn_total, mut return_total) = (0u128, 0u128);
        for item in &plan {
            match item.release {
                Release::Burn { amount } => burn_total = burn_total.saturating_add(amount),
                Release::Return { amount, .. } => {
                    return_total = return_total.saturating_add(amount)
                }
            }
        }
        Some(DispositionView {
            status,
            window_secs: window.map(|ns| U64(ns / NS_PER_SECOND)),
            opens_at_ns: times.map(|(opens, _)| U64(opens)),
            closes_at_ns: times.map(|(_, closes)| U64(closes)),
            burn_weight: U128(burn),
            return_weight: U128(keep),
            escrow_reserved: self.lifecycle_escrow.get(&id).copied() == Some(true),
            escrow_id: hold
                .map(|hold| hex(&escrow_id(&env::current_account_id(), id, hold.community))),
            burn_total: U128(burn_total),
            return_total: U128(return_total),
            released: self.lifecycle_dao_progress.get(&id).copied().unwrap_or(0),
            total_releases: plan.len() as u32,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::{
        AssetIdentity, AuditApproval, BackingApproval, Battle, FeePolicy, ObservationPolicy,
        ScoringMode,
    };
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, PromiseResult};

    const MINUTE: u64 = 60 * NS_PER_SECOND;
    const WON_AT: u64 = 1_000 * NS_PER_SECOND;

    fn account(name: &str) -> AccountId {
        name.parse().expect("account")
    }
    fn context(caller: &str, deposit: NearToken, now: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("arena.testnet"))
            .predecessor_account_id(account(caller))
            .attached_deposit(deposit)
            .block_timestamp(now)
            .build());
    }
    fn panics<F: FnOnce()>(f: F) -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
    }
    fn asset(index: u8) -> AssetIdentity {
        AssetIdentity {
            chain_id: 46630,
            token_address: format!("0x{index:040x}"),
            representation: account(&format!("token{index}.testnet")),
            custody_domain: "vault".into(),
            reference_chain_id: None,
            reference_address: None,
        }
    }
    const STORAGE: NearToken = NearToken::from_millinear(10);

    /// Battle 1: community 0 (creator 60, bob 30, carol 10) beats community 1.
    /// The winner is recorded at `WON_AT` with a 5-minute vote window.
    fn decided_arena(window: Option<u64>) -> Arena {
        context("owner.testnet", NearToken::from_yoctonear(0), 0);
        let mut arena = Arena::new(
            account("owner.testnet"),
            account("usdc.testnet"),
            account("treasury.testnet"),
            U128(0),
            U64(60),
        );
        let fee = FeePolicy {
            fee_bps: 10,
            creator_share_bps: 5000,
            creator: account("creator.testnet"),
            protocol: account("protocol.testnet"),
            protocol_created: false,
        };
        let battle =
            Battle::new(vec![asset(1), asset(2)], ScoringMode::PriceGain, fee).expect("battle");
        let id = arena.lifecycle_insert(battle).expect("insert");
        if let Some(window) = window {
            arena.lifecycle_dao_windows.insert(id, window);
        }
        for index in 0..2usize {
            let identity = asset(index as u8 + 1);
            arena
                .lifecycle_set_audit(
                    id,
                    index,
                    Some(AuditApproval {
                        asset: identity.clone(),
                        policy_hash: "policy".into(),
                        evidence_hash: format!("audit-{index}"),
                        expires_at_ms: 1_000_000_000_000,
                    }),
                )
                .expect("audit");
            arena
                .lifecycle_set_backing(
                    id,
                    index,
                    Some(BackingApproval {
                        asset: identity,
                        evidence_hash: format!("backing-{index}"),
                        expires_at_ms: 1_000_000_000_000,
                    }),
                )
                .expect("backing");
        }
        let deposits: [(u32, &str, u128); 4] = [
            (0, "creator.testnet", 60),
            (0, "bob.testnet", 30),
            (0, "carol.testnet", 10),
            (1, "dave.testnet", 50),
        ];
        for (community, who, amount) in deposits {
            let sender = account(who);
            let token = asset(community as u8 + 1).representation;
            arena
                .lifecycle_register_position(id, community, &sender)
                .expect("position");
            arena
                .lifecycle_credit(id, community, &token, &sender, amount)
                .expect("credit");
        }
        arena
            .lifecycle_lock(
                id,
                ObservationPolicy {
                    version: 1,
                    policy_hash: "terms".into(),
                },
            )
            .expect("lock");
        context("oracle.testnet", NearToken::from_yoctonear(0), WON_AT);
        arena.lifecycle_hold_principal(id, 0).expect("winner");
        arena
    }

    fn vote(arena: &mut Arena, who: &str, burn: bool, now: u64) {
        context(who, STORAGE, now);
        arena.vote_lifecycle_disposition(U64(1), burn);
    }

    #[test]
    fn protocol_sets_a_bounded_window_that_new_battles_snapshot() {
        let mut arena = decided_arena(None);
        arena.lifecycle_protocol = Some(account("protocol.testnet"));
        context("owner.testnet", NearToken::from_yoctonear(1), 0);
        assert!(panics(|| arena.set_lifecycle_dao_window(U64(300))));
        context("protocol.testnet", NearToken::from_yoctonear(1), 0);
        assert!(panics(|| arena.set_lifecycle_dao_window(U64(59))));
        assert!(panics(
            || arena.set_lifecycle_dao_window(U64(MAX_DAO_WINDOW_SECS + 1))
        ));
        arena.set_lifecycle_dao_window(U64(300));
        assert_eq!(arena.get_lifecycle_dao_window(), Some(U64(300)));
        // Battle 1 was created before: it has no vote and its principal stays escrowed.
        let view = arena.get_lifecycle_disposition(U64(1)).expect("view");
        assert_eq!(view.status, DispositionStatus::NoVote);
        assert!(panics(|| vote(&mut arena, "creator.testnet", true, WON_AT)));
    }

    #[test]
    fn only_winning_participants_vote_once_inside_the_window() {
        let mut arena = decided_arena(Some(5 * MINUTE));
        // Losing participant, outsider, owner and oracle hold no winning weight.
        for who in [
            "dave.testnet",
            "stranger.testnet",
            "owner.testnet",
            "oracle.testnet",
        ] {
            assert!(panics(|| vote(&mut arena, who, true, WON_AT + 1)));
        }
        vote(&mut arena, "creator.testnet", true, WON_AT + 1);
        assert!(panics(|| vote(
            &mut arena,
            "creator.testnet",
            false,
            WON_AT + 2
        )));
        // The window is half-open: a vote at the close is refused.
        assert!(panics(|| vote(
            &mut arena,
            "bob.testnet",
            false,
            WON_AT + 5 * MINUTE
        )));
        vote(&mut arena, "bob.testnet", false, WON_AT + 5 * MINUTE - 1);
        let view = arena.get_lifecycle_disposition(U64(1)).expect("view");
        assert_eq!(view.status, DispositionStatus::Voting);
        assert_eq!((view.burn_weight, view.return_weight), (U128(60), U128(30)));
    }

    // Unit-test storage is not rolled back on a panic, so a refused call is
    // checked last (on-chain the whole receipt reverts).
    #[test]
    #[should_panic(expected = "Insufficient storage deposit")]
    fn a_vote_must_pay_for_its_storage() {
        let mut arena = decided_arena(Some(5 * MINUTE));
        context("bob.testnet", NearToken::from_yoctonear(1), WON_AT + 2);
        arena.vote_lifecycle_disposition(U64(1), false);
    }

    #[test]
    fn the_burn_share_of_votes_cast_applies_to_every_holder_rounding_to_return() {
        let mut arena = decided_arena(Some(5 * MINUTE));
        vote(&mut arena, "creator.testnet", true, WON_AT);
        vote(&mut arena, "bob.testnet", false, WON_AT + 1);
        // Carol does not vote and follows the voters.
        context(
            "anyone.testnet",
            NearToken::from_yoctonear(0),
            WON_AT + MINUTE,
        );
        assert_eq!(arena.disposition_plan(1), Err("Vote is still open"));
        context(
            "anyone.testnet",
            NearToken::from_yoctonear(0),
            WON_AT + 5 * MINUTE,
        );
        let plan = arena.disposition_plan(1).expect("plan");
        // B = 60, R = 30: burn floor(p * 60 / 90), the rest is returned.
        let releases: Vec<Release> = plan.iter().map(|item| item.release.clone()).collect();
        assert_eq!(
            releases,
            vec![
                Release::Return {
                    beneficiary: account("creator.testnet"),
                    amount: 20
                },
                Release::Return {
                    beneficiary: account("bob.testnet"),
                    amount: 10
                },
                Release::Return {
                    beneficiary: account("carol.testnet"),
                    amount: 4
                },
                Release::Burn { amount: 66 },
            ]
        );
        let ids: std::collections::BTreeSet<_> = plan.iter().map(|item| item.id).collect();
        assert_eq!(ids.len(), 4);
        assert_eq!(plan, arena.disposition_plan(1).expect("same plan"));
        let view = arena.get_lifecycle_disposition(U64(1)).expect("view");
        assert_eq!(view.status, DispositionStatus::Decided);
        assert_eq!((view.burn_total, view.return_total), (U128(66), U128(34)));
        assert_eq!(view.total_releases, 4);
    }

    // Each test gets its own mocked storage; two arenas in one test would share it.
    #[test]
    fn a_unanimous_burn_vote_burns_everything() {
        let mut burn = decided_arena(Some(5 * MINUTE));
        vote(&mut burn, "carol.testnet", true, WON_AT);
        context(
            "anyone.testnet",
            NearToken::from_yoctonear(0),
            WON_AT + 5 * MINUTE,
        );
        let plan = burn.disposition_plan(1).expect("plan");
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].release, Release::Burn { amount: 100 });
    }

    #[test]
    fn a_unanimous_return_vote_returns_everything() {
        let mut keep = decided_arena(Some(5 * MINUTE));
        vote(&mut keep, "bob.testnet", false, WON_AT);
        context(
            "anyone.testnet",
            NearToken::from_yoctonear(0),
            WON_AT + 5 * MINUTE,
        );
        let plan = keep.disposition_plan(1).expect("plan");
        assert_eq!(plan.len(), 3);
        assert!(plan
            .iter()
            .all(|item| matches!(item.release, Release::Return { .. })));
    }

    #[test]
    fn with_no_vote_the_principal_stays_escrowed_and_nothing_executes() {
        let mut arena = decided_arena(Some(5 * MINUTE));
        arena.lifecycle_escrow.insert(1, true);
        context(
            "anyone.testnet",
            ENTITLEMENT_DEPOSIT,
            WON_AT + 30 * 24 * 60 * MINUTE,
        );
        assert_eq!(
            arena.disposition_plan(1),
            Err("No vote cast: principal stays escrowed")
        );
        let view = arena.get_lifecycle_disposition(U64(1)).expect("view");
        assert_eq!(view.status, DispositionStatus::UndecidedEscrowed);
        assert!(panics(|| {
            let _ = arena.execute_lifecycle_disposition(U64(1), 1);
        }));
        // A vote after the window cannot revive it.
        assert!(panics(|| vote(
            &mut arena,
            "creator.testnet",
            true,
            WON_AT + 6 * MINUTE
        )));
    }

    #[test]
    fn execution_needs_the_escrow_a_closed_vote_a_bounded_batch_and_the_deposit() {
        let mut arena = decided_arena(Some(5 * MINUTE));
        // A split vote, so the plan has four releases (three returns and a burn).
        vote(&mut arena, "creator.testnet", true, WON_AT);
        vote(&mut arena, "bob.testnet", false, WON_AT);
        let after = WON_AT + 5 * MINUTE;
        let four = NearToken::from_yoctonear(ENTITLEMENT_DEPOSIT.as_yoctonear() * 4);
        context("anyone.testnet", four, after);
        // Escrow not reserved in the backing yet.
        assert!(panics(|| {
            let _ = arena.execute_lifecycle_disposition(U64(1), 4);
        }));
        arena.lifecycle_escrow.insert(1, true);
        for size in [0, MAX_BATCH + 1] {
            context("anyone.testnet", four, after);
            assert!(panics(|| {
                let _ = arena.execute_lifecycle_disposition(U64(1), size);
            }));
        }
        context("anyone.testnet", ENTITLEMENT_DEPOSIT, after);
        assert!(panics(|| {
            let _ = arena.execute_lifecycle_disposition(U64(1), 2);
        }));
        context("anyone.testnet", four, WON_AT + MINUTE);
        assert!(panics(|| {
            let _ = arena.execute_lifecycle_disposition(U64(1), 2);
        }));
        context("anyone.testnet", four, after);
        assert!(matches!(
            arena.execute_lifecycle_disposition(U64(1), 4),
            PromiseOrValue::Promise(_)
        ));
    }

    #[test]
    fn cursor_advances_only_after_a_fully_successful_batch_at_the_cursor() {
        let mut arena = decided_arena(Some(5 * MINUTE));
        let with = |results: Vec<PromiseResult>| {
            testing_env!(
                VMContextBuilder::new()
                    .current_account_id(account("arena.testnet"))
                    .predecessor_account_id(account("arena.testnet"))
                    .build(),
                near_sdk::test_vm_config(),
                near_sdk::RuntimeFeesConfig::test(),
                Default::default(),
                results
            )
        };
        let ok = || PromiseResult::Successful(b"true".to_vec());
        with(vec![ok(), PromiseResult::Failed]);
        assert_eq!(arena.on_disposition_batch(U64(1), 0, 2), 0);
        with(vec![ok(), ok()]);
        assert_eq!(arena.on_disposition_batch(U64(1), 1, 3), 0);
        assert_eq!(arena.on_disposition_batch(U64(1), 0, 2), 2);
        // A replayed or stale callback cannot move it back or skip ahead.
        with(vec![ok()]);
        assert_eq!(arena.on_disposition_batch(U64(1), 0, 1), 2);
        assert_eq!(arena.lifecycle_dao_progress.get(&1).copied(), Some(2));
    }

    #[test]
    fn release_ids_bind_arena_battle_and_position() {
        let arena = account("arena.testnet");
        let other = account("other.testnet");
        assert_ne!(release_id(&arena, 1, 0), release_id(&arena, 1, 1));
        assert_ne!(release_id(&arena, 1, 0), release_id(&arena, 2, 0));
        assert_ne!(release_id(&arena, 1, 0), release_id(&other, 1, 0));
        assert_eq!(release_id(&arena, 1, 0), release_id(&arena, 1, 0));
    }
}
