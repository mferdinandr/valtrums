//! Thirty-second rounds and unlimited leader-only overtime.
//!
//! Pure state machine: it validates evidence shape against a frozen policy and
//! compares exact scores. It does not authenticate the evidence provider or
//! the caller; the contract adapter must do both before calling it.
use crate::lifecycle::ScoringMode;
use crate::scoring::{
    has_sample_coverage, market_cap_growth, matches_observation_context, maximum_drawdown,
    price_gain, sum_round_volume, volume_ratio, ObservationContext, ObservationEvidence,
    RoundTrade, SampleCoveragePolicy, Score,
};
use std::cmp::Ordering;
use std::collections::BTreeSet;

pub const ROUND_NS: u64 = 30_000_000_000;
const MAX_DECIMALS: u8 = 36;

/// Canonical fixed-point scales frozen with the observation policy. Prices,
/// circulating supply and quote volume must arrive at exactly these scales.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScalePolicy {
    pub price_decimals: u8,
    pub supply_decimals: u8,
    pub volume_decimals: u8,
}

/// Mode-specific inputs for one candidate. Missing volume is `None`; a complete
/// round without trades is `Some(vec![])`, which is a valid zero.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModeData {
    Price {
        start: u128,
        end: u128,
    },
    MarketCap {
        start_price: u128,
        start_supply: u128,
        end_price: u128,
        end_supply: u128,
    },
    Volume {
        trades: Option<Vec<RoundTrade>>,
        start_price: u128,
        start_supply: u128,
    },
    Drawdown {
        prices: Vec<u128>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CandidateObservation {
    pub community: u32,
    pub evidence: ObservationEvidence,
    pub data: ModeData,
}

#[near_sdk::near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PendingReason {
    /// Observations do not cover exactly the current candidate set.
    CandidateMismatch,
    /// Identity, ordering or boundary coverage of a candidate's evidence failed.
    InvalidEvidence(u32),
    /// Required inputs were missing, nonpositive or overflowed.
    Unscorable(u32),
}

#[near_sdk::near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolution {
    /// Nothing was recorded; the same round stays open.
    Pending(PendingReason),
    /// Tied leaders advance; a fresh round must be opened for them only.
    Overtime {
        next_candidates: Vec<u32>,
    },
    Winner(u32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoundError {
    InvalidConfiguration,
    Finished,
    NotOpen,
    AlreadyOpen,
    WrongRound,
    StartsBeforePreviousEnd,
    /// The revealed terms do not hash to the policy committed at lock.
    PolicyMismatch,
}

/// Everything an observation round depends on besides the battle itself. The
/// lifecycle commits only `digest`; these terms are revealed and checked
/// against that commitment, so none of them can change after lock. The module
/// chooses no values: provider, pools, tolerance and cadence are policy
/// decisions. Data freshness is expressed through `boundary_tolerance_ns`
/// (samples must sit near the recorded boundaries); a late resolver never
/// invalidates evidence for a recorded interval.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservationTerms {
    pub source: String,
    pub quote_currency: String,
    /// Eligible pools or markets used for price and volume.
    pub eligible_pools: Vec<String>,
    /// Source finality requirement, as an identifier the adapter enforces.
    pub finality: String,
    pub price_decimals: u8,
    pub supply_decimals: u8,
    pub volume_decimals: u8,
    pub boundary_tolerance_ns: u64,
    /// Longest allowed gap between consecutive drawdown samples.
    pub max_gap_ns: u64,
}

impl ObservationTerms {
    fn is_complete(&self) -> bool {
        let named = |text: &str| !text.trim().is_empty() && text.len() <= 256;
        named(&self.source)
            && named(&self.quote_currency)
            && named(&self.finality)
            && !self.eligible_pools.is_empty()
            && self.eligible_pools.len() <= 64
            && self.eligible_pools.iter().all(|pool| named(pool))
            && self.max_gap_ns > 0
    }

    /// Canonical, unambiguous commitment: every field is length-prefixed, pools
    /// are sorted and the scoring mode is included. Lowercase hex SHA-256.
    pub fn digest(&self, mode: ScoringMode) -> String {
        let mut pools = self.eligible_pools.clone();
        pools.sort();
        let mut text = format!("valtrum/observation-policy/v1;mode={mode:?};");
        let mut field = |value: &str| text.push_str(&format!("{}:{value};", value.len()));
        field(&self.source);
        field(&self.quote_currency);
        field(&self.finality);
        for pool in &pools {
            field(pool);
        }
        field(&format!(
            "{}/{}/{}/{}/{}",
            self.price_decimals,
            self.supply_decimals,
            self.volume_decimals,
            self.boundary_tolerance_ns,
            self.max_gap_ns
        ));
        near_sdk::env::sha256_array(text.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

#[near_sdk::near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
struct Record {
    round_id: u64,
    outcome: Resolution,
}

#[near_sdk::near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Rounds {
    battle_id: u64,
    mode: ScoringMode,
    policy_hash: String,
    source: String,
    assets: Vec<String>,
    coverage: SampleCoveragePolicy,
    candidates: Vec<u32>,
    round_id: u64,
    window: Option<(u64, u64)>,
    last_end_ns: u64,
    winner: Option<u32>,
    history: Vec<Record>,
}

impl Rounds {
    /// The only production constructor: rounds read their source, scales and
    /// coverage from terms whose digest equals the policy hash frozen at lock.
    pub fn from_frozen_policy(
        battle_id: u64,
        mode: ScoringMode,
        frozen_policy_hash: &str,
        terms: &ObservationTerms,
        assets: Vec<String>,
    ) -> Result<Self, RoundError> {
        if !terms.is_complete() {
            return Err(RoundError::InvalidConfiguration);
        }
        if terms.digest(mode) != frozen_policy_hash {
            return Err(RoundError::PolicyMismatch);
        }
        Self::new(
            battle_id,
            mode,
            frozen_policy_hash.to_string(),
            terms.source.clone(),
            assets,
            SampleCoveragePolicy {
                boundary_tolerance_ns: terms.boundary_tolerance_ns,
                max_gap_ns: terms.max_gap_ns,
            },
            &ScalePolicy {
                price_decimals: terms.price_decimals,
                supply_decimals: terms.supply_decimals,
                volume_decimals: terms.volume_decimals,
            },
        )
    }

    /// `assets` holds one distinct asset identifier per original community,
    /// indexed by community. Every community starts as a candidate.
    pub(crate) fn new(
        battle_id: u64,
        mode: ScoringMode,
        policy_hash: String,
        source: String,
        assets: Vec<String>,
        coverage: SampleCoveragePolicy,
        scales: &ScalePolicy,
    ) -> Result<Self, RoundError> {
        let distinct: BTreeSet<&String> = assets.iter().collect();
        let scales_ok = scales.price_decimals <= MAX_DECIMALS
            && scales.supply_decimals <= MAX_DECIMALS
            && scales.volume_decimals <= MAX_DECIMALS
            && (mode != ScoringMode::VolumeRatio
                || scales.volume_decimals == scales.price_decimals + scales.supply_decimals);
        if assets.len() < 2
            || distinct.len() != assets.len()
            || assets.iter().any(|a| a.trim().is_empty())
            || policy_hash.trim().is_empty()
            || source.trim().is_empty()
            || coverage.max_gap_ns == 0
            || !scales_ok
        {
            return Err(RoundError::InvalidConfiguration);
        }
        let candidates = (0..assets.len() as u32).collect();
        Ok(Self {
            battle_id,
            mode,
            policy_hash,
            source,
            assets,
            coverage,
            candidates,
            round_id: 1,
            window: None,
            last_end_ns: 0,
            winner: None,
            history: Vec::new(),
        })
    }

    pub fn mode(&self) -> ScoringMode {
        self.mode
    }

    /// The identity every observation of the open round must carry, built from
    /// the frozen configuration so a submitter cannot choose it. `None` when no
    /// round is open or the community is unknown.
    pub fn context_for(&self, community: u32) -> Option<ObservationContext> {
        let (start_ns, end_ns) = self.window?;
        Some(ObservationContext {
            battle_id: self.battle_id,
            round_id: self.round_id,
            asset_id: self.assets.get(community as usize)?.clone(),
            source: self.source.clone(),
            policy_hash: self.policy_hash.clone(),
            start_ns,
            end_ns,
        })
    }
    pub fn community_count(&self) -> usize {
        self.assets.len()
    }
    pub fn candidates(&self) -> &[u32] {
        &self.candidates
    }
    pub fn current_round(&self) -> u64 {
        self.round_id
    }
    /// The recorded `[start, end)` of the open round; never moved by late calls.
    pub fn window(&self) -> Option<(u64, u64)> {
        self.window
    }
    /// Set only by a unique-leader resolution of complete evidence.
    pub fn winner(&self) -> Option<u32> {
        self.winner
    }

    /// Record the next round's immutable 30-second window. Repeating the same
    /// request is harmless; a different start for the open round is rejected.
    pub fn open_round(&mut self, round_id: u64, start_ns: u64) -> Result<(u64, u64), RoundError> {
        if self.winner.is_some() {
            return Err(RoundError::Finished);
        }
        if round_id != self.round_id {
            return Err(RoundError::WrongRound);
        }
        if let Some((start, end)) = self.window {
            return if start == start_ns {
                Ok((start, end))
            } else {
                Err(RoundError::AlreadyOpen)
            };
        }
        if start_ns < self.last_end_ns {
            return Err(RoundError::StartsBeforePreviousEnd);
        }
        let end = start_ns
            .checked_add(ROUND_NS)
            .ok_or(RoundError::InvalidConfiguration)?;
        self.window = Some((start_ns, end));
        Ok((start_ns, end))
    }

    /// Score the open round. Any missing, conflicting or malformed evidence
    /// leaves the round open and records nothing. Resolving an already resolved
    /// round returns its recorded outcome.
    pub fn resolve_round(
        &mut self,
        round_id: u64,
        observations: &[CandidateObservation],
    ) -> Result<Resolution, RoundError> {
        if let Some(done) = self.history.iter().find(|r| r.round_id == round_id) {
            return Ok(done.outcome.clone());
        }
        if self.winner.is_some() {
            return Err(RoundError::Finished);
        }
        if round_id != self.round_id {
            return Err(RoundError::WrongRound);
        }
        let (start_ns, end_ns) = self.window.ok_or(RoundError::NotOpen)?;
        let mut seen: Vec<u32> = observations.iter().map(|o| o.community).collect();
        seen.sort_unstable();
        if seen != self.candidates {
            return Ok(Resolution::Pending(PendingReason::CandidateMismatch));
        }
        let mut scored: Vec<(u32, Score)> = Vec::with_capacity(observations.len());
        for observation in observations {
            let community = observation.community;
            let context = ObservationContext {
                battle_id: self.battle_id,
                round_id,
                asset_id: self.assets[community as usize].clone(),
                source: self.source.clone(),
                policy_hash: self.policy_hash.clone(),
                start_ns,
                end_ns,
            };
            if !self.evidence_is_valid(&context, observation) {
                return Ok(Resolution::Pending(PendingReason::InvalidEvidence(
                    community,
                )));
            }
            match self.score(&context, &observation.data) {
                Some(score) => scored.push((community, score)),
                None => return Ok(Resolution::Pending(PendingReason::Unscorable(community))),
            }
        }
        let lowest_wins = self.mode == ScoringMode::LowestDrawdown;
        let better = |a: &Score, b: &Score| {
            let order = a.compare(b);
            if lowest_wins {
                order.reverse()
            } else {
                order
            }
        };
        let mut leaders: Vec<u32> = Vec::new();
        let mut best: Option<&Score> = None;
        for (community, score) in &scored {
            match best.map(|b| better(score, b)) {
                None | Some(Ordering::Greater) => {
                    best = Some(score);
                    leaders = vec![*community];
                }
                Some(Ordering::Equal) => leaders.push(*community),
                Some(Ordering::Less) => {}
            }
        }
        leaders.sort_unstable();
        let outcome = if leaders.len() == 1 {
            self.winner = Some(leaders[0]);
            Resolution::Winner(leaders[0])
        } else {
            self.candidates = leaders.clone();
            self.round_id += 1;
            self.window = None;
            self.last_end_ns = end_ns;
            Resolution::Overtime {
                next_candidates: leaders,
            }
        };
        self.history.push(Record {
            round_id,
            outcome: outcome.clone(),
        });
        Ok(outcome)
    }

    fn evidence_is_valid(&self, context: &ObservationContext, o: &CandidateObservation) -> bool {
        if !matches_observation_context(context, &o.evidence) {
            return false;
        }
        let times = &o.evidence.observed_times_ns;
        if self.mode == ScoringMode::LowestDrawdown {
            // One ordered price per observation time, with gap and boundary coverage.
            let ModeData::Drawdown { prices } = &o.data else {
                return false;
            };
            return prices.len() == times.len()
                && has_sample_coverage(context, &o.evidence, &self.coverage);
        }
        // Endpoint modes need a valid start and end point near the boundaries.
        let tolerance = self.coverage.boundary_tolerance_ns;
        times.len() >= 2
            && times[0].abs_diff(context.start_ns) <= tolerance
            && times[times.len() - 1].abs_diff(context.end_ns) <= tolerance
    }

    fn score(&self, context: &ObservationContext, data: &ModeData) -> Option<Score> {
        match (self.mode, data) {
            (ScoringMode::PriceGain, ModeData::Price { start, end }) => price_gain(*start, *end),
            (
                ScoringMode::MarketCapGrowth,
                ModeData::MarketCap {
                    start_price,
                    start_supply,
                    end_price,
                    end_supply,
                },
            ) => market_cap_growth(*start_price, *start_supply, *end_price, *end_supply),
            (
                ScoringMode::VolumeRatio,
                ModeData::Volume {
                    trades: Some(trades),
                    start_price,
                    start_supply,
                },
            ) => volume_ratio(
                sum_round_volume(context, trades)?,
                *start_price,
                *start_supply,
            ),
            (ScoringMode::LowestDrawdown, ModeData::Drawdown { prices }) => {
                maximum_drawdown(prices)
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_000_000_000_000;

    fn rounds(mode: ScoringMode, count: usize) -> Rounds {
        let volume = if mode == ScoringMode::VolumeRatio {
            8
        } else {
            6
        };
        Rounds::new(
            1,
            mode,
            "policy".into(),
            "source".into(),
            (0..count).map(|i| format!("asset-{i}")).collect(),
            SampleCoveragePolicy {
                boundary_tolerance_ns: 1_000,
                max_gap_ns: ROUND_NS,
            },
            &ScalePolicy {
                price_decimals: 6,
                supply_decimals: 2,
                volume_decimals: volume,
            },
        )
        .expect("rounds")
    }

    fn evidence(r: &Rounds, round: u64, community: u32, times: Vec<u64>) -> ObservationEvidence {
        let (start, end) = r.window().expect("open");
        ObservationEvidence {
            context: ObservationContext {
                battle_id: 1,
                round_id: round,
                asset_id: format!("asset-{community}"),
                source: "source".into(),
                policy_hash: "policy".into(),
                start_ns: start,
                end_ns: end,
            },
            observed_times_ns: if times.is_empty() {
                vec![start, end]
            } else {
                times
            },
            evidence_hash: "hash".into(),
        }
    }

    fn price(
        r: &Rounds,
        round: u64,
        community: u32,
        start: u128,
        end: u128,
    ) -> CandidateObservation {
        CandidateObservation {
            community,
            evidence: evidence(r, round, community, vec![]),
            data: ModeData::Price { start, end },
        }
    }

    #[test]
    fn three_communities_repeat_ties_with_fresh_scores_and_eliminate_for_good() {
        let mut r = rounds(ScoringMode::PriceGain, 3);
        r.open_round(1, T0).expect("open");
        let first = [
            price(&r, 1, 0, 100, 110),
            price(&r, 1, 1, 100, 110),
            price(&r, 1, 2, 100, 102),
        ];
        assert_eq!(
            r.resolve_round(1, &first),
            Ok(Resolution::Overtime {
                next_candidates: vec![0, 1]
            })
        );
        assert_eq!(r.candidates(), &[0, 1]);
        assert_eq!(
            r.open_round(2, T0),
            Err(RoundError::StartsBeforePreviousEnd)
        );
        r.open_round(2, T0 + ROUND_NS).expect("open 2");
        // The eliminated community cannot re-enter.
        let with_c = [
            price(&r, 2, 0, 100, 97),
            price(&r, 2, 1, 100, 97),
            price(&r, 2, 2, 100, 150),
        ];
        assert_eq!(
            r.resolve_round(2, &with_c),
            Ok(Resolution::Pending(PendingReason::CandidateMismatch))
        );
        let second = [price(&r, 2, 0, 100, 97), price(&r, 2, 1, 100, 97)];
        assert_eq!(
            r.resolve_round(2, &second),
            Ok(Resolution::Overtime {
                next_candidates: vec![0, 1]
            })
        );
        r.open_round(3, T0 + 2 * ROUND_NS).expect("open 3");
        // Fresh negative scores: -4% beats -5% and earlier rounds do not accumulate.
        let third = [price(&r, 3, 0, 100, 96), price(&r, 3, 1, 100, 95)];
        assert_eq!(r.resolve_round(3, &third), Ok(Resolution::Winner(0)));
        assert_eq!(r.winner(), Some(0));
        assert_eq!(
            r.open_round(4, T0 + 3 * ROUND_NS),
            Err(RoundError::Finished)
        );
        // Duplicate resolution returns the recorded outcome and cannot change it.
        let flipped = [price(&r, 3, 0, 100, 90), price(&r, 3, 1, 100, 99)];
        assert_eq!(r.resolve_round(3, &flipped), Ok(Resolution::Winner(0)));
    }

    #[test]
    fn missing_or_invalid_evidence_holds_the_round_pending_without_a_default() {
        let mut r = rounds(ScoringMode::PriceGain, 2);
        assert_eq!(r.resolve_round(1, &[]), Err(RoundError::NotOpen));
        r.open_round(1, T0).expect("open");
        assert_eq!(r.open_round(1, T0 + 1), Err(RoundError::AlreadyOpen));
        assert_eq!(r.open_round(1, T0), Ok((T0, T0 + ROUND_NS)));
        assert_eq!(
            r.resolve_round(1, &[price(&r, 1, 0, 100, 110)]),
            Ok(Resolution::Pending(PendingReason::CandidateMismatch))
        );
        assert_eq!(
            r.resolve_round(1, &[price(&r, 1, 0, 100, 110), price(&r, 1, 0, 100, 110)]),
            Ok(Resolution::Pending(PendingReason::CandidateMismatch))
        );
        // Zero or missing endpoint price cannot be scored.
        assert_eq!(
            r.resolve_round(1, &[price(&r, 1, 0, 100, 110), price(&r, 1, 1, 100, 0)]),
            Ok(Resolution::Pending(PendingReason::Unscorable(1)))
        );
        // Wrong round, source and shifted boundaries are rejected as evidence.
        let mut wrong_round = price(&r, 1, 1, 100, 100);
        wrong_round.evidence.context.round_id = 2;
        assert_eq!(
            r.resolve_round(1, &[price(&r, 1, 0, 100, 110), wrong_round]),
            Ok(Resolution::Pending(PendingReason::InvalidEvidence(1)))
        );
        let mut late = price(&r, 1, 1, 100, 100);
        late.evidence.observed_times_ns = vec![T0 + 5_000, T0 + ROUND_NS];
        assert_eq!(
            r.resolve_round(1, &[price(&r, 1, 0, 100, 110), late]),
            Ok(Resolution::Pending(PendingReason::InvalidEvidence(1)))
        );
        assert_eq!(r.resolve_round(2, &[]), Err(RoundError::WrongRound));
        assert_eq!(r.window(), Some((T0, T0 + ROUND_NS)));
        assert_eq!(r.winner(), None);
        let good = [price(&r, 1, 0, 100, 110), price(&r, 1, 1, 100, 100)];
        assert_eq!(r.resolve_round(1, &good), Ok(Resolution::Winner(0)));
    }

    #[test]
    fn out_of_order_or_overwritten_observations_cannot_change_a_round() {
        let mut r = rounds(ScoringMode::PriceGain, 2);
        r.open_round(1, T0).expect("open");
        let end = T0 + ROUND_NS;
        let mut reversed = price(&r, 1, 1, 100, 100);
        reversed.evidence.observed_times_ns = vec![end, T0];
        assert_eq!(
            r.resolve_round(1, &[price(&r, 1, 0, 100, 110), reversed]),
            Ok(Resolution::Pending(PendingReason::InvalidEvidence(1)))
        );
        let mut blank_hash = price(&r, 1, 1, 100, 100);
        blank_hash.evidence.evidence_hash = " ".into();
        assert_eq!(
            r.resolve_round(1, &[price(&r, 1, 0, 100, 110), blank_hash]),
            Ok(Resolution::Pending(PendingReason::InvalidEvidence(1)))
        );
        // A wrong-mode payload is unscorable, not a default.
        let mut wrong_mode = price(&r, 1, 1, 100, 100);
        wrong_mode.data = ModeData::Drawdown { prices: vec![1, 2] };
        assert_eq!(
            r.resolve_round(1, &[price(&r, 1, 0, 100, 110), wrong_mode]),
            Ok(Resolution::Pending(PendingReason::Unscorable(1)))
        );
        assert_eq!(r.window(), Some((T0, end)));
        // After a recorded tie a later, different submission for that round is ignored.
        let tie = [price(&r, 1, 0, 100, 105), price(&r, 1, 1, 100, 105)];
        let overwrite = [price(&r, 1, 0, 100, 150), price(&r, 1, 1, 100, 90)];
        let recorded = r.resolve_round(1, &tie);
        assert_eq!(
            recorded,
            Ok(Resolution::Overtime {
                next_candidates: vec![0, 1]
            })
        );
        assert_eq!(r.resolve_round(1, &overwrite), recorded);
        assert_eq!(r.candidates(), &[0, 1]);
    }

    #[test]
    fn market_cap_uses_circulating_supply_at_both_endpoints() {
        let mut r = rounds(ScoringMode::MarketCapGrowth, 2);
        r.open_round(1, T0).expect("open");
        let cap = |c, sp, ss, ep, es| CandidateObservation {
            community: c,
            evidence: evidence(&r, 1, c, vec![]),
            data: ModeData::MarketCap {
                start_price: sp,
                start_supply: ss,
                end_price: ep,
                end_supply: es,
            },
        };
        // A: price 2 -> 2.2, supply 1000 -> 900 is -1%; B: 1 -> 1, 2000 -> 2100 is +5%.
        let obs = [cap(0, 20, 1000, 22, 900), cap(1, 10, 2000, 10, 2100)];
        assert_eq!(r.resolve_round(1, &obs), Ok(Resolution::Winner(1)));
    }

    #[test]
    fn volume_ratio_distinguishes_complete_zero_from_missing_and_uses_initial_cap() {
        let mut r = rounds(ScoringMode::VolumeRatio, 2);
        r.open_round(1, T0).expect("open");
        let view = r.clone();
        let vol = |c, trades: Option<Vec<RoundTrade>>, cap_supply| CandidateObservation {
            community: c,
            evidence: evidence(&view, 1, c, vec![]),
            data: ModeData::Volume {
                trades,
                start_price: 1,
                start_supply: cap_supply,
            },
        };
        let trade = |id: &str, ts, v| RoundTrade {
            id: id.into(),
            timestamp_ns: ts,
            quote_volume: v,
        };
        let missing = [
            vol(0, Some(vec![trade("a", T0, 300)]), 1000),
            vol(1, None, 2000),
        ];
        assert_eq!(
            r.resolve_round(1, &missing),
            Ok(Resolution::Pending(PendingReason::Unscorable(1)))
        );
        // A trade exactly at t1 belongs to the next round and makes the set invalid.
        let at_end = [
            vol(0, Some(vec![trade("a", T0 + ROUND_NS, 300)]), 1000),
            vol(1, Some(vec![]), 2000),
        ];
        assert_eq!(
            r.resolve_round(1, &at_end),
            Ok(Resolution::Pending(PendingReason::Unscorable(0)))
        );
        // A: 300 / 1000 = 0.30; B: 400 / 2000 = 0.20; a trade at t0 is included.
        let ok = [
            vol(0, Some(vec![trade("a", T0, 300)]), 1000),
            vol(1, Some(vec![trade("b", T0 + 1, 400)]), 2000),
        ];
        assert_eq!(r.resolve_round(1, &ok), Ok(Resolution::Winner(0)));
        // Two complete zero-volume candidates tie exactly.
        let mut tie = rounds(ScoringMode::VolumeRatio, 2);
        tie.open_round(1, T0).expect("open");
        let zero = |c, s| CandidateObservation {
            community: c,
            evidence: evidence(&tie, 1, c, vec![]),
            data: ModeData::Volume {
                trades: Some(vec![]),
                start_price: 1,
                start_supply: s,
            },
        };
        assert_eq!(
            tie.resolve_round(1, &[zero(0, 1000), zero(1, 7)]),
            Ok(Resolution::Overtime {
                next_candidates: vec![0, 1]
            })
        );
    }

    #[test]
    fn lowest_drawdown_wins_and_sample_gaps_hold_pending() {
        let mut r = rounds(ScoringMode::LowestDrawdown, 2);
        r.open_round(1, T0).expect("open");
        let end = T0 + ROUND_NS;
        let path = |c, prices: Vec<u128>, times: Vec<u64>| CandidateObservation {
            community: c,
            evidence: evidence(&r, 1, c, times),
            data: ModeData::Drawdown { prices },
        };
        let times4 = vec![T0, T0 + 10_000_000_000, T0 + 20_000_000_000, end];
        // 100 -> 120 -> 90 -> 110 has 25% drawdown; 100 -> 95 -> 105 -> 100 has 5%.
        let obs = [
            path(0, vec![100, 120, 90, 110], times4.clone()),
            path(1, vec![100, 95, 105, 100], times4.clone()),
        ];
        // Fewer prices than observation times is incomplete evidence.
        let short = [
            path(0, vec![100, 120, 90], times4.clone()),
            path(1, vec![100, 95, 105, 100], times4.clone()),
        ];
        assert_eq!(
            r.resolve_round(1, &short),
            Ok(Resolution::Pending(PendingReason::InvalidEvidence(0)))
        );
        // A 30-second gap exceeds a stricter cadence, so it is held pending too.
        let mut strict = rounds(ScoringMode::LowestDrawdown, 2);
        strict.coverage.max_gap_ns = 10_000_000_000;
        strict.open_round(1, T0).expect("open");
        let two = vec![T0, end];
        let sparse = |c| CandidateObservation {
            community: c,
            evidence: evidence(&strict, 1, c, two.clone()),
            data: ModeData::Drawdown {
                prices: vec![100, 100],
            },
        };
        assert_eq!(
            strict.resolve_round(1, &[sparse(0), sparse(1)]),
            Ok(Resolution::Pending(PendingReason::InvalidEvidence(0)))
        );
        assert_eq!(r.resolve_round(1, &obs), Ok(Resolution::Winner(1)));
    }

    fn terms() -> ObservationTerms {
        ObservationTerms {
            source: "source".into(),
            quote_currency: "USD".into(),
            eligible_pools: vec!["pool-b".into(), "pool-a".into()],
            finality: "finalized".into(),
            price_decimals: 6,
            supply_decimals: 2,
            volume_decimals: 8,
            boundary_tolerance_ns: 1_000,
            max_gap_ns: ROUND_NS,
        }
    }

    #[test]
    fn rounds_only_start_from_terms_matching_the_frozen_policy_hash() {
        let mode = ScoringMode::VolumeRatio;
        let frozen = terms().digest(mode);
        let assets = || vec!["a".to_string(), "b".to_string()];
        assert_eq!(frozen.len(), 64);
        // Pool order is canonicalized; mode and every field change the commitment.
        let mut reordered = terms();
        reordered.eligible_pools.reverse();
        assert_eq!(reordered.digest(mode), frozen);
        assert_ne!(terms().digest(ScoringMode::PriceGain), frozen);
        let altered: [fn(&mut ObservationTerms); 6] = [
            |t| t.source = "other".into(),
            |t| t.finality = "latest".into(),
            |t| t.price_decimals = 7,
            |t| t.boundary_tolerance_ns = 2_000,
            |t| t.max_gap_ns = 1,
            |t| t.eligible_pools.push("pool-c".into()),
        ];
        for change in altered {
            let mut other = terms();
            change(&mut other);
            assert_ne!(other.digest(mode), frozen);
            // Terms revealed after lock must match; the changed ones are refused.
            assert_eq!(
                Rounds::from_frozen_policy(1, mode, &frozen, &other, assets()).err(),
                Some(RoundError::PolicyMismatch)
            );
        }
        let r = Rounds::from_frozen_policy(1, mode, &frozen, &terms(), assets()).expect("rounds");
        assert_eq!(r.mode(), mode);
        // Field boundaries cannot be forged by shifting characters between fields.
        let (mut a, mut b) = (terms(), terms());
        (a.source, a.quote_currency) = ("ab".into(), "c".into());
        (b.source, b.quote_currency) = ("a".into(), "bc".into());
        assert_ne!(a.digest(mode), b.digest(mode));
        // Incomplete terms and a mismatched volume scale are rejected even if hashed.
        let mut incomplete = terms();
        incomplete.eligible_pools.clear();
        let hash = incomplete.digest(mode);
        assert_eq!(
            Rounds::from_frozen_policy(1, mode, &hash, &incomplete, assets()).err(),
            Some(RoundError::InvalidConfiguration)
        );
        let mut scale = terms();
        scale.volume_decimals = 3;
        let hash = scale.digest(mode);
        assert_eq!(
            Rounds::from_frozen_policy(1, mode, &hash, &scale, assets()).err(),
            Some(RoundError::InvalidConfiguration)
        );
    }

    #[test]
    fn configuration_rejects_bad_assets_policy_and_volume_scale() {
        let ok_cov = || SampleCoveragePolicy {
            boundary_tolerance_ns: 0,
            max_gap_ns: ROUND_NS,
        };
        let scales = ScalePolicy {
            price_decimals: 6,
            supply_decimals: 2,
            volume_decimals: 8,
        };
        let make = |assets: Vec<&str>, mode, scales: &ScalePolicy| {
            Rounds::new(
                1,
                mode,
                "p".into(),
                "s".into(),
                assets.into_iter().map(String::from).collect(),
                ok_cov(),
                scales,
            )
        };
        assert!(make(vec!["a", "b"], ScoringMode::VolumeRatio, &scales).is_ok());
        assert!(make(vec!["a"], ScoringMode::PriceGain, &scales).is_err());
        assert!(make(vec!["a", "a"], ScoringMode::PriceGain, &scales).is_err());
        let mismatch = ScalePolicy {
            volume_decimals: 6,
            ..scales.clone()
        };
        assert!(make(vec!["a", "b"], ScoringMode::VolumeRatio, &mismatch).is_err());
        let huge = ScalePolicy {
            price_decimals: 40,
            ..scales
        };
        assert!(make(vec!["a", "b"], ScoringMode::PriceGain, &huge).is_err());
    }
}
