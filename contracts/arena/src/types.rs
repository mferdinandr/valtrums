use near_sdk::json_types::{U128, U64};
use near_sdk::near;
use near_sdk::AccountId;

/// Seconds-to-nanoseconds helper; NEAR block timestamps are in nanoseconds.
pub const NS_PER_SECOND: u64 = 1_000_000_000;
/// Every round lasts exactly this long.
pub const ROUND_SECS: u64 = 30;
/// Longest time a battle may stay in gathering before lock is refused by policy.
pub const MAX_GATHERING_SECS: u64 = 30 * 24 * 60 * 60;

/// Identity of a community's token. Chain id and token address, never symbol
/// alone. The backing account is the NEP-141 representation contract.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenIdentity {
    pub chain_id: u64,
    pub token_address: String,
    pub backing: AccountId,
    pub decimals: u8,
    pub custody_domain: String,
    pub symbol: String,
}

/// One of the four selectable scoring modes. Fixed for the whole battle.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScoringMode {
    PriceGain,
    MarketCapGrowth,
    VolumeRatio,
    LowestDrawdown,
}

impl ScoringMode {
    /// Required evidence fields per mode (see docs/battle-rules.md).
    pub fn requires(self) -> ModeRequirements {
        match self {
            ScoringMode::PriceGain => ModeRequirements {
                start_price: true,
                end_price: true,
                supply: false,
                volume: false,
                path: false,
            },
            ScoringMode::MarketCapGrowth => ModeRequirements {
                start_price: true,
                end_price: true,
                supply: true,
                volume: false,
                path: false,
            },
            ScoringMode::VolumeRatio => ModeRequirements {
                start_price: true,
                end_price: false,
                supply: true,
                volume: true,
                path: false,
            },
            ScoringMode::LowestDrawdown => ModeRequirements {
                start_price: false,
                end_price: false,
                supply: false,
                volume: false,
                path: true,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModeRequirements {
    pub start_price: bool,
    pub end_price: bool,
    pub supply: bool,
    pub volume: bool,
    pub path: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BattleStatus {
    /// Communities chosen, audit pending.
    Proposed,
    /// Audit and LP passed, deposits open (gathering).
    Approved,
    /// Snapshot frozen, round 1 running (or overtime).
    Live,
    /// A unique winner exists; settlement allocation done.
    Settled,
    /// Rejected by audit or an invalid snapshot; no deposits were locked.
    Rejected,
}

impl BattleStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, BattleStatus::Settled | BattleStatus::Rejected)
    }
}

/// A community competing in a battle.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Community {
    pub index: u16,
    pub token: TokenIdentity,
    /// Frozen at lock; `None` means audit/lp evidence is missing or pending.
    pub audit: Option<AuditEvidence>,
    /// Locked vault in the token's smallest representation unit.
    pub vault: u128,
    /// Whether the community has been eliminated by an earlier round.
    pub eliminated: bool,
}

/// Per-community audit evidence frozen with the snapshot.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditEvidence {
    /// Overall decision after GoPlus mapping and LP gate.
    pub decision: AuditDecision,
    pub goplus: GoPlusEvidence,
    pub lp: LpEvidence,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuditDecision {
    Pass,
    Pending,
    Reject,
}

/// Normalized GoPlus evidence (see docs/goplus-audit.md).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GoPlusEvidence {
    /// chain_id and token_address the response is bound to.
    pub chain_id: u64,
    pub token_address: String,
    /// Provider/API version and policy version.
    pub provider_version: String,
    pub policy_version: u64,
    /// Time the evidence was queried (ns).
    pub queried_at_ns: U64,
    pub is_honeypot: TriState,
    pub cannot_sell_all: TriState,
    pub cannot_buy: TriState,
    /// Tax fractions as exact decimal scaled by 1e6 (1_000_000 == 100%).
    /// None is Unknown/missing.
    pub buy_tax: Option<u64>,
    pub sell_tax: Option<u64>,
    pub transfer_tax: Option<u64>,
    /// Whether privilege/ownership/inspection checks were fully evidenced
    /// (proxy/closed-source omissions keep this false).
    pub coverage_complete: bool,
    /// Whether the OPEN tax/admin threshold policy has been explicitly
    /// resolved for this evidence. Nonzero taxes stay Pending until true.
    pub tax_policy_resolved: bool,
    /// Raw response hash for later schema-change detection.
    pub evidence_hash: String,
}

/// Tri-state value after explicit normalization: string "1" is true, "0" is
/// false; missing/null/unexpected stays Unknown.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TriState {
    True,
    False,
    Unknown,
}

/// Independent LP evidence; value must be strictly above USD 10,000.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LpEvidence {
    /// USD valuation scaled by 1e6.
    pub usd_value_scaled: U128,
    /// Valuation source and observation time/block.
    pub source: String,
    pub observed_at_ns: U64,
    pub evidence_hash: String,
}

/// Frozen reference to the versioned observation policy (docs/battle-rules.md).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyRef {
    pub version: u64,
    /// Hash of the policy document that was committed before lock.
    pub policy_hash: String,
}

/// One round's evidence for one community. Point observations, no TWAP.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RoundEvidence {
    pub start_price: Option<U128>,
    pub end_price: Option<U128>,
    pub start_supply: Option<U128>,
    pub end_supply: Option<U128>,
    /// Quote volume over [t0, t1) in USD scaled units.
    pub volume: Option<U128>,
    /// Ordered price path for drawdown, including start and end points.
    pub path: Option<Vec<U128>>,
}

/// A battle between two or more token communities.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Battle {
    pub id: u64,
    pub creator: AccountId,
    /// Protocol-created battles charge the whole 0.1% fee to the protocol.
    pub protocol_created: bool,
    pub mode: ScoringMode,
    pub status: BattleStatus,
    pub communities: Vec<Community>,
    /// Frozen at lock; nothing may change it afterwards.
    pub policy_ref: Option<PolicyRef>,
    pub created_at_ns: u64,
    pub locked_at_ns: Option<u64>,
    /// Current round number (1-based).
    pub round: u32,
    pub round_start_ns: u64,
    pub round_end_ns: u64,
    /// Indices into `communities` still competing.
    pub candidates: Vec<u16>,
    pub winner: Option<u16>,
    pub settled_at_ns: Option<u64>,
    pub escrow: Option<DaoEscrow>,
}

/// Winning principal escrowed for DAO disposition. Governance stays OPEN.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaoEscrow {
    pub battle_id: u64,
    /// Locked winner principal units (representations held by the arena).
    pub principal: U128,
    pub status: EscrowStatus,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscrowStatus {
    Escrowed,
    Disposing,
    Disposed,
}

/// A recorded DAO decision. Membership/weights/quorum/deadline stay OPEN; an
/// explicit decision record gates disposal so nothing is invented silently.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaoDecision {
    pub battle_id: u64,
    pub kind: DisposalKind,
    pub recorded_at_ns: U64,
    /// Reference to the governance artifact behind the decision.
    pub decision_ref: String,
    pub consumed: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisposalKind {
    Burn,
    Return,
}

/// A player-agent grant: explicit user delegation with on-chain enforcement.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub id: u64,
    pub grantor: AccountId,
    pub agent: AccountId,
    /// Per-asset budget (backing account -> remaining units).
    pub budget: Vec<(AccountId, U128)>,
    /// Whitelisted arena methods the agent may call.
    pub methods: Vec<String>,
    /// Allowed chain ids.
    pub chains: Vec<u64>,
    /// Allowed destination backing accounts.
    pub assets: Vec<AccountId>,
    pub expires_at_ns: U64,
    pub revoked: bool,
}

/// Outstanding observation state per (battle, round, community).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RoundState {
    pub evidence: RoundEvidence,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_seconds_is_thirty() {
        assert_eq!(ROUND_SECS, 30);
    }

    #[test]
    fn mode_requirements_map_correctly() {
        let r = ScoringMode::VolumeRatio.requires();
        assert!(r.start_price && r.supply && r.volume);
        assert!(!r.end_price && !r.path);
        let d = ScoringMode::LowestDrawdown.requires();
        assert!(d.path && !d.start_price);
    }

    #[test]
    fn terminal_statuses() {
        assert!(BattleStatus::Settled.is_terminal());
        assert!(BattleStatus::Rejected.is_terminal());
        assert!(!BattleStatus::Live.is_terminal());
    }
}
