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

    /// Oracle only. Records the immutable window of the next round.
    pub fn open_lifecycle_round(&mut self, battle_id: U64, round_id: U64, start_ns: U64) {
        self.assert_oracle();
        require!(!self.paused, "Arena is paused");
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
    pub fn submit_lifecycle_observations(
        &mut self,
        battle_id: U64,
        round_id: U64,
        observations: Vec<CandidateObservationInput>,
    ) -> RoundOutcome {
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
        let resolution = rounds
            .resolve_round(round_id, candidates)
            .unwrap_or_else(|error| env::panic_str(&format!("Round rejected: {error:?}")));
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
mod tests {
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
    fn locked_arena() -> Arena {
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
            context(caller, NearToken::from_yoctonear(0), START);
            assert!(panics(|| arena.open_lifecycle_round(
                U64(1),
                U64(1),
                U64(START)
            )));
            assert!(panics(|| {
                arena.submit_lifecycle_observations(U64(1), U64(1), vec![]);
            }));
        }
        context("oracle.testnet", NearToken::from_yoctonear(0), START);
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
        context("oracle.testnet", NearToken::from_yoctonear(0), START);
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
            NearToken::from_yoctonear(0),
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
            NearToken::from_yoctonear(0),
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
}
