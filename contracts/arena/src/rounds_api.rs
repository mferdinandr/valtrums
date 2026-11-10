//! Contract-facing round methods for lifecycle battles.
//!
//! Only the oracle fixed with `set_lifecycle_oracle` opens rounds and submits
//! observations. Everything that binds an observation to its battle, round,
//! asset, source, policy and interval is built by the contract from the frozen
//! configuration, so the oracle supplies only sample times, an evidence hash
//! and mode data. A unique winner found by `Rounds` is recorded as the held
//! principal automatically; no caller-supplied winner label is accepted.
use crate::rounds::{
    CandidateObservation, ModeData, ObservationTerms, PendingReason, Resolution, Rounds,
};
use crate::scoring::{ObservationEvidence, RoundTrade};
use crate::{Arena, ArenaExt};
use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, NearToken, Promise};

/// How far a round's start may lie from the block time, in either direction.
const MAX_WINDOW_SKEW_NS: u64 = 300_000_000_000;

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservationTermsInput {
    pub source: String,
    pub quote_currency: String,
    pub eligible_pools: Vec<String>,
    pub finality: String,
    pub price_decimals: u8,
    pub supply_decimals: u8,
    pub volume_decimals: u8,
    pub boundary_tolerance_ns: U64,
    pub max_gap_ns: U64,
}

impl From<ObservationTermsInput> for ObservationTerms {
    fn from(value: ObservationTermsInput) -> Self {
        Self {
            source: value.source,
            quote_currency: value.quote_currency,
            eligible_pools: value.eligible_pools,
            finality: value.finality,
            price_decimals: value.price_decimals,
            supply_decimals: value.supply_decimals,
            volume_decimals: value.volume_decimals,
            boundary_tolerance_ns: value.boundary_tolerance_ns.0,
            max_gap_ns: value.max_gap_ns.0,
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TradeInput {
    pub id: String,
    pub timestamp_ns: U64,
    pub quote_volume: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModeDataInput {
    Price {
        start: U128,
        end: U128,
    },
    MarketCap {
        start_price: U128,
        start_supply: U128,
        end_price: U128,
        end_supply: U128,
    },
    /// `trades: null` means volume evidence is missing; `[]` is a complete zero.
    Volume {
        trades: Option<Vec<TradeInput>>,
        start_price: U128,
        start_supply: U128,
    },
    Drawdown {
        prices: Vec<U128>,
    },
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CandidateObservationInput {
    pub community: u32,
    pub observed_times_ns: Vec<U64>,
    pub evidence_hash: String,
    pub data: ModeDataInput,
}

impl From<ModeDataInput> for ModeData {
    fn from(value: ModeDataInput) -> Self {
        match value {
            ModeDataInput::Price { start, end } => ModeData::Price {
                start: start.0,
                end: end.0,
            },
            ModeDataInput::MarketCap {
                start_price,
                start_supply,
                end_price,
                end_supply,
            } => ModeData::MarketCap {
                start_price: start_price.0,
                start_supply: start_supply.0,
                end_price: end_price.0,
                end_supply: end_supply.0,
            },
            ModeDataInput::Volume {
                trades,
                start_price,
                start_supply,
            } => ModeData::Volume {
                trades: trades.map(|list| {
                    list.into_iter()
                        .map(|trade| RoundTrade {
                            id: trade.id,
                            timestamp_ns: trade.timestamp_ns.0,
                            quote_volume: trade.quote_volume.0,
                        })
                        .collect()
                }),
                start_price: start_price.0,
                start_supply: start_supply.0,
            },
            ModeDataInput::Drawdown { prices } => ModeData::Drawdown {
                prices: prices.into_iter().map(|price| price.0).collect(),
            },
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoundOutcome {
    /// Nothing was recorded; the same round stays open.
    Pending {
        reason: String,
    },
    /// These communities tie and need a fresh round; the others are eliminated.
    Overtime {
        next_candidates: Vec<u32>,
    },
    Winner {
        community: u32,
    },
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundView {
    pub round_id: U64,
    pub candidates: Vec<u32>,
    pub start_ns: Option<U64>,
    pub end_ns: Option<U64>,
    pub winner: Option<u32>,
}

fn describe(reason: &PendingReason) -> String {
    match reason {
        PendingReason::CandidateMismatch => "candidate_mismatch".into(),
        PendingReason::InvalidEvidence(community) => format!("invalid_evidence:{community}"),
        PendingReason::Unscorable(community) => format!("unscorable:{community}"),
    }
}

#[near]
impl Arena {
    /// Reveal the observation terms of a locked battle. Anyone may call: the
    /// terms must hash to the policy frozen at lock, so nobody can choose them.
    #[payable]
    pub fn start_lifecycle_rounds(&mut self, battle_id: U64, terms: ObservationTermsInput) {
        require!(!self.paused, "Arena is paused");
        require!(
            !self.lifecycle_rounds.contains_key(&battle_id.0),
            "Rounds already started"
        );
        let battle = self
            .lifecycle_battles
            .get(&battle_id.0)
            .unwrap_or_else(|| env::panic_str("Unknown lifecycle battle"));
        let frozen = battle
            .frozen_policy()
            .unwrap_or_else(|| env::panic_str("Battle is not locked"))
            .policy_hash
            .clone();
        let rounds = Rounds::from_frozen_policy(
            battle_id.0,
            battle.mode(),
            &frozen,
            &ObservationTerms::from(terms),
            battle.asset_labels(),
        )
        .unwrap_or_else(|error| env::panic_str(&format!("Rounds rejected: {error:?}")));
        let before = env::storage_usage();
        self.lifecycle_rounds.insert(battle_id.0, rounds);
        self.lifecycle_rounds.flush();
        self.charge_storage(before);
    }

    /// Oracle only. Records the immutable window of the next round. The start
    /// must be within `MAX_WINDOW_SKEW_NS` of the current block time, so the
    /// oracle can neither pick a historical window nor park a battle on a
    /// distant future one.
    #[payable]
    pub fn open_lifecycle_round(&mut self, battle_id: U64, round_id: U64, start_ns: U64) {
        near_sdk::assert_one_yocto();
        self.assert_oracle();
        require!(!self.paused, "Arena is paused");
        let now = env::block_timestamp();
        require!(
            start_ns.0 <= now.saturating_add(MAX_WINDOW_SKEW_NS)
                && start_ns.0.saturating_add(MAX_WINDOW_SKEW_NS) >= now,
            "Round start is too far from the current time"
        );
        let rounds = self
            .lifecycle_rounds
            .get_mut(&battle_id.0)
            .unwrap_or_else(|| env::panic_str("Rounds not started"));
        rounds
            .open_round(round_id.0, start_ns.0)
            .unwrap_or_else(|error| env::panic_str(&format!("Round rejected: {error:?}")));
    }

    /// Oracle only, and only after the round's recorded end. A unique winner is
    /// recorded as the held principal in the same call. Incomplete or invalid
    /// evidence returns `Pending` and leaves the round open.
    #[payable]
    pub fn submit_lifecycle_observations(
        &mut self,
        battle_id: U64,
        round_id: U64,
        observations: Vec<CandidateObservationInput>,
    ) -> RoundOutcome {
        near_sdk::assert_one_yocto();
        self.assert_oracle();
        require!(!self.paused, "Arena is paused");
        let rounds = self
            .lifecycle_rounds
            .get(&battle_id.0)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Rounds not started"));
        if let Some((_, end_ns)) = rounds.window() {
            require!(env::block_timestamp() >= end_ns, "Round has not ended");
        }
        let mut candidates = Vec::with_capacity(observations.len());
        for input in observations {
            let Some(context) = rounds.context_for(input.community) else {
                // No open round or unknown community: let Rounds report the state.
                return self.finish_round(&battle_id, rounds, round_id.0, &[]);
            };
            candidates.push(CandidateObservation {
                community: input.community,
                evidence: ObservationEvidence {
                    context,
                    observed_times_ns: input.observed_times_ns.iter().map(|t| t.0).collect(),
                    evidence_hash: input.evidence_hash,
                },
                data: input.data.into(),
            });
        }
        self.finish_round(&battle_id, rounds, round_id.0, &candidates)
    }

    /// Hex sha256 commitment recorded when the round was finalized (`valtrum-round-v1`), or `None`
    /// for an unknown battle, a round that is not finalized and any round finalized before the
    /// commitment existed. The full detail is in the `round_finalized` event.
    pub fn get_lifecycle_round_commitment(&self, battle_id: U64, round_id: U64) -> Option<String> {
        self.lifecycle_rounds
            .get(&battle_id.0)?
            .commitment(round_id.0)
            .map(|c| hex_of(&c))
    }

    pub fn get_lifecycle_round(&self, battle_id: U64) -> Option<RoundView> {
        let rounds = self.lifecycle_rounds.get(&battle_id.0)?;
        let window = rounds.window();
        Some(RoundView {
            round_id: U64(rounds.current_round()),
            candidates: rounds.candidates().to_vec(),
            start_ns: window.map(|w| U64(w.0)),
            end_ns: window.map(|w| U64(w.1)),
            winner: rounds.winner(),
        })
    }
}

fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Arena {
    fn assert_oracle(&self) {
        require!(
            self.lifecycle_oracle.as_ref() == Some(&env::predecessor_account_id()),
            "Only the oracle can call this method"
        );
    }

    fn finish_round(
        &mut self,
        battle_id: &U64,
        mut rounds: Rounds,
        round_id: u64,
        candidates: &[CandidateObservation],
    ) -> RoundOutcome {
        let (resolution, finalization) = rounds
            .resolve_round_detailed(round_id, candidates)
            .unwrap_or_else(|error| env::panic_str(&format!("Round rejected: {error:?}")));
        if let Some(done) = &finalization {
            let (kind, winner, next) = match &resolution {
                Resolution::Winner(community) => ("winner", Some(*community), Vec::new()),
                Resolution::Overtime { next_candidates } => {
                    ("overtime", None, next_candidates.clone())
                }
                Resolution::Pending(_) => ("pending", None, Vec::new()),
            };
            // Versioned, lossless detail for the indexer; state keeps only the 32-byte commitment.
            crate::events::emit(
                "round_finalized",
                near_sdk::serde_json::json!({
                    "schema": "round-finalized-v1",
                    "battle_id": battle_id.0.to_string(),
                    "round_id": done.round_id.to_string(),
                    "outcome": kind,
                    "winner": winner,
                    "next_candidates": next,
                    "start_ns": done.start_ns.to_string(),
                    "end_ns": done.end_ns.to_string(),
                    "policy_hash": done.policy_hash,
                    "commitment": hex_of(&done.commitment),
                    "scores": done.scores.iter().map(|(community, evidence_hash, score)| {
                        let (negative, numerator, denominator) = score.parts();
                        near_sdk::serde_json::json!({
                            "community": community,
                            "evidence_hash": evidence_hash,
                            "negative": negative,
                            "numerator": numerator,
                            "denominator": denominator,
                        })
                    }).collect::<Vec<_>>(),
                }),
            );
        }
        let outcome = match resolution {
            Resolution::Pending(reason) => {
                return RoundOutcome::Pending {
                    reason: describe(&reason),
                }
            }
            Resolution::Overtime { next_candidates } => RoundOutcome::Overtime { next_candidates },
            Resolution::Winner(community) => {
                let mut battle = self
                    .lifecycle_battles
                    .get(&battle_id.0)
                    .cloned()
                    .unwrap_or_else(|| env::panic_str("Unknown lifecycle battle"));
                battle
                    .hold_principal_from_scoring(&rounds)
                    .unwrap_or_else(|_| env::panic_str("Winner cannot be recorded"));
                self.lifecycle_battles.insert(battle_id.0, battle);
                // The DAO vote on the winning principal opens now.
                self.lifecycle_winner_at
                    .insert(battle_id.0, env::block_timestamp());
                RoundOutcome::Winner { community }
            }
        };
        self.lifecycle_rounds.insert(battle_id.0, rounds);
        outcome
    }

    /// Charge the storage added since `before` to the attached deposit and
    /// refund the rest.
    fn charge_storage(&self, before: u64) {
        let cost = env::storage_byte_cost()
            .as_yoctonear()
            .checked_mul(u128::from(env::storage_usage().saturating_sub(before)))
            .unwrap_or_else(|| env::panic_str("Storage cost overflow"));
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, "Insufficient storage deposit");
        if attached > cost {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(attached - cost))
                .detach();
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::lifecycle::{
        AssetIdentity, AuditApproval, BackingApproval, Battle, FeePolicy, ObservationPolicy,
        ScoringMode,
    };
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, AccountId};

    const START: u64 = 1_000_000_000_000;
    const ROUND: u64 = 30_000_000_000;

    fn account(name: &str) -> AccountId {
        name.parse().expect("account")
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
    fn context(caller: &str, deposit: NearToken, now: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(account(caller))
            .attached_deposit(deposit)
            .block_timestamp(now)
            .build());
    }

    /// An arena with the oracle fixed and one locked three-community battle.
    pub(crate) fn locked_arena() -> Arena {
        context("owner.testnet", NearToken::from_yoctonear(0), 0);
        let mut arena = Arena::new(
            account("owner.testnet"),
            account("usdc.testnet"),
            account("treasury.testnet"),
            U128(0),
            U64(60),
        );
        context("owner.testnet", NearToken::from_yoctonear(1), 0);
        arena.set_lifecycle_oracle(account("oracle.testnet"));
        let fee = FeePolicy {
            fee_bps: 10,
            creator_share_bps: 5000,
            creator: account("creator.testnet"),
            protocol: account("protocol.testnet"),
            protocol_created: false,
        };
        let battle = Battle::new(
            vec![asset(1), asset(2), asset(3)],
            ScoringMode::PriceGain,
            fee,
        )
        .expect("battle");
        let id = arena.lifecycle_insert(battle).expect("insert");
        for index in 0..3usize {
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
                        asset: identity.clone(),
                        evidence_hash: format!("backing-{index}"),
                        expires_at_ms: 1_000_000_000_000,
                    }),
                )
                .expect("backing");
        }
        // Credits are accepted only once every community is approved.
        for index in 0..3usize {
            let identity = asset(index as u8 + 1);
            let sender = account(if index == 0 {
                "creator.testnet"
            } else {
                "other.testnet"
            });
            arena
                .lifecycle_register_position(id, index as u32, &sender)
                .expect("position");
            arena
                .lifecycle_credit(id, index as u32, &identity.representation, &sender, 10)
                .expect("credit");
        }
        let digest = ObservationTerms::from(terms()).digest(ScoringMode::PriceGain);
        arena
            .lifecycle_lock(
                id,
                ObservationPolicy {
                    version: 1,
                    policy_hash: digest,
                },
            )
            .expect("lock");
        arena
    }

    fn observation(community: u32, end_price: u128, start: u64) -> CandidateObservationInput {
        CandidateObservationInput {
            community,
            observed_times_ns: vec![U64(start), U64(start + ROUND)],
            evidence_hash: "evidence".into(),
            data: ModeDataInput::Price {
                start: U128(100),
                end: U128(end_price),
            },
        }
    }

    fn panics<F: FnOnce()>(f: F) -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
    }

    #[test]
    fn only_the_fixed_oracle_drives_rounds_and_terms_must_match_the_frozen_hash() {
        let mut arena = locked_arena();
        // The oracle is set once and cannot be replaced.
        context("owner.testnet", NearToken::from_yoctonear(1), 0);
        assert!(panics(
            || arena.set_lifecycle_oracle(account("other.testnet"))
        ));
        // Terms that differ from the committed ones are refused; the real ones are accepted.
        context("anyone.testnet", NearToken::from_near(1), 0);
        let mut forged = terms();
        forged.source = "other".into();
        assert!(panics(|| arena.start_lifecycle_rounds(U64(1), forged)));
        assert!(panics(|| arena.open_lifecycle_round(
            U64(1),
            U64(1),
            U64(START)
        )));
        arena.start_lifecycle_rounds(U64(1), terms());
        assert!(panics(|| arena.start_lifecycle_rounds(U64(1), terms())));
        for caller in ["anyone.testnet", "owner.testnet"] {
            context(caller, NearToken::from_yoctonear(1), START);
            assert!(panics(|| arena.open_lifecycle_round(
                U64(1),
                U64(1),
                U64(START)
            )));
            assert!(panics(|| {
                arena.submit_lifecycle_observations(U64(1), U64(1), vec![]);
            }));
        }
        // Without the one yocto, even the oracle is refused.
        context("oracle.testnet", NearToken::from_yoctonear(0), START);
        assert!(panics(|| arena.open_lifecycle_round(
            U64(1),
            U64(1),
            U64(START)
        )));
        // A start far from the block time is refused in both directions.
        context("oracle.testnet", NearToken::from_yoctonear(1), START);
        assert!(panics(|| arena.open_lifecycle_round(
            U64(1),
            U64(1),
            U64(START - MAX_WINDOW_SKEW_NS - 1)
        )));
        assert!(panics(|| arena.open_lifecycle_round(
            U64(1),
            U64(1),
            U64(START + MAX_WINDOW_SKEW_NS + 1)
        )));
        arena.open_lifecycle_round(U64(1), U64(1), U64(START));
        let view = arena.get_lifecycle_round(U64(1)).expect("view");
        assert_eq!(
            (view.start_ns, view.end_ns, view.candidates),
            (Some(U64(START)), Some(U64(START + ROUND)), vec![0, 1, 2])
        );
    }

    #[test]
    fn repeated_ties_then_a_unique_winner_hold_the_principal_automatically() {
        let mut arena = locked_arena();
        context("anyone.testnet", NearToken::from_near(1), 0);
        arena.start_lifecycle_rounds(U64(1), terms());
        context("oracle.testnet", NearToken::from_yoctonear(1), START);
        arena.open_lifecycle_round(U64(1), U64(1), U64(START));
        // A round cannot be resolved before its recorded end.
        let early = vec![
            observation(0, 110, START),
            observation(1, 110, START),
            observation(2, 102, START),
        ];
        assert!(panics(|| {
            arena.submit_lifecycle_observations(U64(1), U64(1), early.clone());
        }));
        context(
            "oracle.testnet",
            NearToken::from_yoctonear(1),
            START + ROUND,
        );
        // Missing evidence for a candidate holds the round, with no winner recorded.
        assert_eq!(
            arena.submit_lifecycle_observations(U64(1), U64(1), early[..2].to_vec()),
            RoundOutcome::Pending {
                reason: "candidate_mismatch".into()
            }
        );
        assert_eq!(
            arena.submit_lifecycle_observations(U64(1), U64(1), early.clone()),
            RoundOutcome::Overtime {
                next_candidates: vec![0, 1]
            }
        );
        assert!(arena
            .lifecycle_battles
            .get(&1)
            .expect("battle")
            .principal_hold()
            .is_none());
        // Overtime: a fresh window for the tied leaders only; the eliminated one cannot return.
        arena.open_lifecycle_round(U64(1), U64(2), U64(START + ROUND));
        context(
            "oracle.testnet",
            NearToken::from_yoctonear(1),
            START + 2 * ROUND,
        );
        let with_eliminated = vec![
            observation(0, 96, START + ROUND),
            observation(1, 95, START + ROUND),
            observation(2, 150, START + ROUND),
        ];
        assert_eq!(
            arena.submit_lifecycle_observations(U64(1), U64(2), with_eliminated),
            RoundOutcome::Pending {
                reason: "candidate_mismatch".into()
            }
        );
        let fin = vec![
            observation(0, 96, START + ROUND),
            observation(1, 95, START + ROUND),
        ];
        assert_eq!(
            arena.submit_lifecycle_observations(U64(1), U64(2), fin.clone()),
            RoundOutcome::Winner { community: 0 }
        );
        let battle = arena.lifecycle_battles.get(&1).expect("battle");
        let hold = battle.principal_hold().expect("hold");
        assert_eq!((hold.community, hold.amount), (0, 10));
        // Repeating the resolution returns the recorded winner and cannot flip it.
        let flipped = vec![
            observation(0, 90, START + ROUND),
            observation(1, 99, START + ROUND),
        ];
        assert_eq!(
            arena.submit_lifecycle_observations(U64(1), U64(2), flipped),
            RoundOutcome::Winner { community: 0 }
        );
        assert_eq!(
            arena.get_lifecycle_round(U64(1)).expect("view").winner,
            Some(0)
        );
    }

    fn round_events() -> Vec<near_sdk::serde_json::Value> {
        near_sdk::test_utils::get_logs()
            .iter()
            .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
            .filter_map(|body| {
                near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(body).ok()
            })
            .filter(|event| event["event"] == "round_finalized")
            .map(|event| event["data"][0].clone())
            .collect()
    }

    #[test]
    fn a_finalized_round_emits_one_versioned_event_matching_the_stored_commitment() {
        let mut arena = locked_arena();
        context("anyone.testnet", NearToken::from_near(1), 0);
        arena.start_lifecycle_rounds(U64(1), terms());
        context("oracle.testnet", NearToken::from_yoctonear(1), START);
        arena.open_lifecycle_round(U64(1), U64(1), U64(START));
        assert!(arena
            .get_lifecycle_round_commitment(U64(1), U64(1))
            .is_none());
        context(
            "oracle.testnet",
            NearToken::from_yoctonear(1),
            START + ROUND,
        );
        let obs = vec![
            observation(0, 110, START),
            observation(1, 100, START),
            observation(2, 102, START),
        ];
        // Pending records and emits nothing.
        assert_eq!(
            arena.submit_lifecycle_observations(U64(1), U64(1), obs[..2].to_vec()),
            RoundOutcome::Pending {
                reason: "candidate_mismatch".into()
            }
        );
        assert!(round_events().is_empty());
        assert!(arena
            .get_lifecycle_round_commitment(U64(1), U64(1))
            .is_none());

        assert_eq!(
            arena.submit_lifecycle_observations(U64(1), U64(1), obs.clone()),
            RoundOutcome::Winner { community: 0 }
        );
        let events = round_events();
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event["schema"], "round-finalized-v1");
        assert_eq!(event["battle_id"], "1");
        assert_eq!(event["round_id"], "1");
        assert_eq!(event["outcome"], "winner");
        assert_eq!(event["winner"], 0);
        assert_eq!(event["start_ns"], START.to_string());
        assert_eq!(event["end_ns"], (START + ROUND).to_string());
        let scores = event["scores"].as_array().expect("scores");
        assert_eq!(scores.len(), 3);
        assert_eq!(scores[0]["community"], 0);
        assert_eq!(scores[0]["negative"], false);
        let stored = arena
            .get_lifecycle_round_commitment(U64(1), U64(1))
            .expect("commitment");
        assert_eq!(stored, event["commitment"].as_str().expect("hex"));
        assert_eq!(stored.len(), 64);

        // Repeating a recorded round emits nothing and keeps the same commitment.
        context(
            "oracle.testnet",
            NearToken::from_yoctonear(1),
            START + ROUND,
        );
        assert_eq!(
            arena.submit_lifecycle_observations(U64(1), U64(1), obs),
            RoundOutcome::Winner { community: 0 }
        );
        assert!(round_events().is_empty());
        assert_eq!(
            arena.get_lifecycle_round_commitment(U64(1), U64(1)),
            Some(stored)
        );
    }

    /// Cross-language vector: the indexer (`agent/test/indexer/round-commitment.test.ts`) and an
    /// independent Python encoding produce the same digest for the same detail.
    #[test]
    fn the_commitment_matches_the_cross_language_vector() {
        use crate::rounds::round_commitment;
        let gain = crate::scoring::tests_support_price_gain(100, 110);
        let loss = crate::scoring::tests_support_price_gain(100, 95);
        assert_eq!(gain.parts(), (false, "10".into(), "100".into()));
        assert_eq!(loss.parts(), (true, "5".into(), "100".into()));
        let scores = vec![(0u32, "h0".to_string(), gain), (2, "h2".into(), loss)];
        let digest = round_commitment(1, 2, 1000, 2000, "pol", &scores);
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "4f93bb7b193a54cb56f5ab4301ddf3e76bd12593c8f4026d4c92a1e40779a1fc"
        );
    }

    #[test]
    fn the_commitment_binds_window_policy_and_every_score() {
        use crate::rounds::round_commitment;
        let score = |v: u128| crate::scoring::tests_support_price_gain(100, v);
        let scores = vec![
            (0u32, "h0".to_string(), score(110)),
            (1, "h1".into(), score(105)),
        ];
        let base = round_commitment(1, 1, 10, 20, "p", &scores);
        assert_eq!(base, round_commitment(1, 1, 10, 20, "p", &scores));
        assert_ne!(base, round_commitment(2, 1, 10, 20, "p", &scores));
        assert_ne!(base, round_commitment(1, 2, 10, 20, "p", &scores));
        assert_ne!(base, round_commitment(1, 1, 11, 20, "p", &scores));
        assert_ne!(base, round_commitment(1, 1, 10, 21, "p", &scores));
        assert_ne!(base, round_commitment(1, 1, 10, 20, "q", &scores));
        let changed = vec![
            (0u32, "h0".to_string(), score(111)),
            (1, "h1".into(), score(105)),
        ];
        assert_ne!(base, round_commitment(1, 1, 10, 20, "p", &changed));
        let rehash = vec![
            (0u32, "hX".to_string(), score(110)),
            (1, "h1".into(), score(105)),
        ];
        assert_ne!(base, round_commitment(1, 1, 10, 20, "p", &rehash));
        assert_ne!(base, round_commitment(1, 1, 10, 20, "p", &scores[..1]));
    }
}
