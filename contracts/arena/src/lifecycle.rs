//! Internal model for the redesigned lifecycle. This is not a contract API.
//!
//! A future adapter must authenticate representation tokens and approval
//! evidence, keep positions in keyed contract storage, and write the returned
//! position in the same transaction as the battle. No input to this module
//! by itself proves foreign custody or an audit result.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};
use std::collections::BTreeSet;

/// Testnet limit; gas at this limit must be verified before live use.
pub const MAX_COMMUNITIES: usize = 16;
/// Bound metadata copied into snapshots so a single field cannot consume the
/// transaction or storage budget for the entire battle.
const MAX_METADATA_BYTES: usize = 256;

/// Settlement reads every winning participant on each call, so the number of
/// depositors per community is bounded to keep it inside one call's gas.
pub const MAX_PARTICIPANTS_PER_COMMUNITY: u32 = 300;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetIdentity {
    pub chain_id: u64,
    pub token_address: String,
    pub representation: AccountId,
    pub custody_domain: String,
    /// Optional mainnet reference token this asset represents (both fields set or both unset).
    /// Committed with the community so a later change cannot reuse an earlier audit approval.
    pub reference_chain_id: Option<u64>,
    /// 20-byte lowercase hex address of the reference token.
    pub reference_address: Option<String>,
}

/// JSON-facing identity keeps 64-bit chain IDs exact in JavaScript clients.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetInput {
    pub chain_id: U64,
    pub token_address: String,
    pub representation: AccountId,
    pub custody_domain: String,
    pub reference_chain_id: Option<U64>,
    pub reference_address: Option<String>,
}

impl From<AssetInput> for AssetIdentity {
    fn from(value: AssetInput) -> Self {
        Self {
            chain_id: value.chain_id.0,
            token_address: value.token_address,
            representation: value.representation,
            custody_domain: value.custody_domain,
            reference_chain_id: value.reference_chain_id.map(|id| id.0),
            reference_address: value.reference_address.map(|a| a.to_ascii_lowercase()),
        }
    }
}

#[cfg(test)]
impl From<AssetIdentity> for AssetInput {
    fn from(value: AssetIdentity) -> Self {
        Self {
            chain_id: U64(value.chain_id),
            token_address: value.token_address,
            representation: value.representation,
            custody_domain: value.custody_domain,
            reference_chain_id: value.reference_chain_id.map(U64),
            reference_address: value.reference_address,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScoringMode {
    PriceGain,
    MarketCapGrowth,
    VolumeRatio,
    LowestDrawdown,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeePolicy {
    pub fee_bps: u16,
    pub creator_share_bps: u16,
    pub creator: AccountId,
    pub protocol: AccountId,
    pub protocol_created: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservationPolicy {
    pub version: u64,
    pub policy_hash: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservationPolicyInput {
    pub version: U64,
    pub policy_hash: String,
}

impl From<ObservationPolicyInput> for ObservationPolicy {
    fn from(value: ObservationPolicyInput) -> Self {
        Self {
            version: value.version.0,
            policy_hash: value.policy_hash,
        }
    }
}

#[cfg(test)]
impl From<ObservationPolicy> for ObservationPolicyInput {
    fn from(value: ObservationPolicy) -> Self {
        Self {
            version: U64(value.version),
            policy_hash: value.policy_hash,
        }
    }
}

impl ObservationPolicy {
    pub fn is_valid(&self) -> bool {
        !self.policy_hash.trim().is_empty() && self.policy_hash.len() <= MAX_METADATA_BYTES
    }
}

/// Outcome reported by the audit adapter for one community. Only `Pass`
/// records an approval; `Reject` and `Pending` withdraw any earlier approval so
/// a stale pass cannot survive a refreshed negative or unknown result.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuditResult {
    Pass,
    Reject,
    Pending,
}

/// References supplied independently by the audit and backing adapters.
/// An evidence reference is not itself proof of validity or authorization.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditApproval {
    pub asset: AssetIdentity,
    pub policy_hash: String,
    pub evidence_hash: String,
    /// Block time in milliseconds at or after which the approval no longer
    /// supports a lock. Set only from the authenticated audit submission.
    pub expires_at_ms: u64,
}

/// Longest approval life accepted at submission (24 hours).
pub const MAX_AUDIT_APPROVAL_MS: u64 = 86_400_000;

/// Facts the lock re-verifies against each stored approval.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockCheck {
    /// Current block time in milliseconds.
    pub now_ms: u64,
    /// When the owner pinned an audit policy hash, every approval must carry it.
    pub required_policy_hash: Option<String>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackingApproval {
    pub asset: AssetIdentity,
    pub evidence_hash: String,
    /// Block time in milliseconds at or after which the approval no longer
    /// supports a lock. Set only by the authenticated backing check.
    pub expires_at_ms: u64,
}

/// Life of a backing approval (10 minutes, the default audit evidence lifetime of D2).
/// Lock re-verifies it so a backing suspended after the check cannot be locked.
pub const BACKING_APPROVAL_MS: u64 = 600_000;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Community {
    pub asset: AssetIdentity,
    pub vault: u128,
    pub audit: Option<AuditApproval>,
    pub backing: Option<BackingApproval>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub communities: Vec<Community>,
    pub mode: ScoringMode,
    pub fee: FeePolicy,
    pub observation: ObservationPolicy,
    /// The creator held a credited position when the battle locked.
    pub creator_participated: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommunityView {
    pub chain_id: U64,
    pub token_address: String,
    pub representation: AccountId,
    pub custody_domain: String,
    pub reference_chain_id: Option<U64>,
    pub reference_address: Option<String>,
    pub vault: U128,
    pub audit_policy_hash: Option<String>,
    pub audit_evidence_hash: Option<String>,
    /// Expiry of the stored audit approval (block time, milliseconds).
    pub audit_expires_at_ms: Option<U64>,
    pub backing_evidence_hash: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LifecycleView {
    pub creator: AccountId,
    pub protocol: AccountId,
    pub protocol_created: bool,
    pub fee_bps: u16,
    pub creator_share_bps: u16,
    pub mode: ScoringMode,
    pub communities: Vec<CommunityView>,
    pub locked: bool,
    pub observation_policy_version: Option<U64>,
    pub observation_policy_hash: Option<String>,
    pub principal_community: Option<u32>,
    pub principal_amount: Option<U128>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LifecyclePositionView {
    pub registered: bool,
    pub amount: U128,
}

/// Accounting hold over the winning representation units. Backing reservation
/// and source-chain disposition are separate integrations and are not implied.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrincipalHold {
    pub community: u32,
    pub asset: AssetIdentity,
    pub amount: u128,
}

/// Read-only settlement input. This is not an allocation, entitlement, or
/// exclusive backing reservation; those are owned by later integrations.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LosingVault {
    pub community: u32,
    pub winner: u32,
    pub asset: AssetIdentity,
    pub amount: u128,
    pub fee: FeePolicy,
}

/// Positions are stored separately by (battle, community, account). Once
/// locked, the same state guard that rejects deposits must guard every write
/// to those keys. Locking does not iterate over or copy every player's position.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Battle {
    communities: Vec<Community>,
    mode: ScoringMode,
    fee: FeePolicy,
    creator_has_position: bool,
    snapshot: Option<Snapshot>,
    principal_hold: Option<PrincipalHold>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecycleError {
    UnknownBattle,
    TooFewCommunities,
    TooManyCommunities,
    InvalidAsset,
    DuplicateAsset,
    InvalidPolicy,
    InvalidCommunity,
    WrongRepresentation,
    InvalidAmount,
    Overflow,
    Locked,
    MissingApproval,
    InvalidApproval,
    /// An approval is at or past its expiry.
    ExpiredApproval,
    /// An approval no longer matches the committed asset or the pinned policy.
    ApprovalMismatch,
    EmptyVault,
    CreatorHasNoPosition,
    NotLocked,
    ConflictingWinner,
    WinnerNotResolved,
    WinningVault,
    PositionNotRegistered,
    PositionAlreadyRegistered,
    /// A community already has the most depositors settlement can process.
    TooManyParticipants,
}

fn is_evm_address(text: &str) -> bool {
    text.strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .is_some_and(|value| {
            value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

impl Battle {
    pub fn new(
        assets: Vec<AssetIdentity>,
        mode: ScoringMode,
        fee: FeePolicy,
    ) -> Result<Self, LifecycleError> {
        if assets.len() < 2 {
            return Err(LifecycleError::TooFewCommunities);
        }
        if assets.len() > MAX_COMMUNITIES {
            return Err(LifecycleError::TooManyCommunities);
        }
        if fee.fee_bps > 10_000
            || fee.creator_share_bps > 10_000
            || (fee.protocol_created && fee.creator != fee.protocol)
        {
            return Err(LifecycleError::InvalidPolicy);
        }
        let mut original_assets = BTreeSet::new();
        let mut references = BTreeSet::new();
        let mut representations = BTreeSet::new();
        let mut communities = Vec::with_capacity(assets.len());
        for asset in assets {
            let address = asset
                .token_address
                .strip_prefix("0x")
                .or_else(|| asset.token_address.strip_prefix("0X"));
            if !address.is_some_and(|value| {
                value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            }) || asset.custody_domain.trim().is_empty()
                || asset.custody_domain.len() > MAX_METADATA_BYTES
            {
                return Err(LifecycleError::InvalidAsset);
            }
            // The reference pair is both-or-neither, a valid 20-byte address, stored lowercase.
            match (asset.reference_chain_id, asset.reference_address.as_deref()) {
                (None, None) => {}
                (Some(chain), Some(address)) if chain > 0 && is_evm_address(address) => {
                    if !references.insert((chain, address.to_ascii_lowercase())) {
                        return Err(LifecycleError::DuplicateAsset);
                    }
                }
                _ => return Err(LifecycleError::InvalidAsset),
            }
            // Chain IDs identify EVM chains; their hex addresses are case-insensitive.
            if !original_assets.insert((asset.chain_id, asset.token_address.to_ascii_lowercase()))
                || !representations.insert(asset.representation.clone())
            {
                return Err(LifecycleError::DuplicateAsset);
            }
            let mut asset = asset;
            asset.reference_address = asset.reference_address.map(|a| a.to_ascii_lowercase());
            communities.push(Community {
                asset,
                vault: 0,
                audit: None,
                backing: None,
            });
        }
        Ok(Self {
            communities,
            mode,
            fee,
            creator_has_position: false,
            snapshot: None,
            principal_hold: None,
        })
    }

    pub fn view(&self) -> LifecycleView {
        let communities = self
            .snapshot
            .as_ref()
            .map_or(&self.communities, |snapshot| &snapshot.communities);
        LifecycleView {
            creator: self.fee.creator.clone(),
            protocol: self.fee.protocol.clone(),
            protocol_created: self.fee.protocol_created,
            fee_bps: self.fee.fee_bps,
            creator_share_bps: self.fee.creator_share_bps,
            mode: self.mode,
            communities: communities
                .iter()
                .map(|community| CommunityView {
                    chain_id: U64(community.asset.chain_id),
                    token_address: community.asset.token_address.clone(),
                    representation: community.asset.representation.clone(),
                    custody_domain: community.asset.custody_domain.clone(),
                    reference_chain_id: community.asset.reference_chain_id.map(U64),
                    reference_address: community.asset.reference_address.clone(),
                    vault: U128(community.vault),
                    audit_policy_hash: community.audit.as_ref().map(|e| e.policy_hash.clone()),
                    audit_evidence_hash: community.audit.as_ref().map(|e| e.evidence_hash.clone()),
                    audit_expires_at_ms: community.audit.as_ref().map(|e| U64(e.expires_at_ms)),
                    backing_evidence_hash: community
                        .backing
                        .as_ref()
                        .map(|e| e.evidence_hash.clone()),
                })
                .collect(),
            locked: self.snapshot.is_some(),
            observation_policy_version: self
                .snapshot
                .as_ref()
                .map(|snapshot| U64(snapshot.observation.version)),
            observation_policy_hash: self
                .snapshot
                .as_ref()
                .map(|snapshot| snapshot.observation.policy_hash.clone()),
            principal_community: self.principal_hold.as_ref().map(|hold| hold.community),
            principal_amount: self.principal_hold.as_ref().map(|hold| U128(hold.amount)),
        }
    }

    fn can_register_position(&self, community: u32) -> Result<(), LifecycleError> {
        if self.snapshot.is_some() {
            return Err(LifecycleError::Locked);
        }
        if self.communities.get(community as usize).is_none() {
            return Err(LifecycleError::InvalidCommunity);
        }
        Ok(())
    }

    /// The audit adapter must authenticate and evaluate this evidence.
    pub fn set_audit(
        &mut self,
        community: usize,
        evidence: Option<AuditApproval>,
    ) -> Result<(), LifecycleError> {
        if self.snapshot.is_some() {
            return Err(LifecycleError::Locked);
        }
        let entry = self
            .communities
            .get_mut(community)
            .ok_or(LifecycleError::InvalidCommunity)?;
        if let Some(ref approval) = evidence {
            if approval.asset != entry.asset
                || approval.policy_hash.trim().is_empty()
                || approval.policy_hash.len() > MAX_METADATA_BYTES
                || approval.evidence_hash.trim().is_empty()
                || approval.evidence_hash.len() > MAX_METADATA_BYTES
                || approval.expires_at_ms == 0
            {
                return Err(LifecycleError::InvalidApproval);
            }
        }
        entry.audit = evidence;
        Ok(())
    }

    /// The backing adapter must authenticate and verify this evidence.
    pub fn set_backing(
        &mut self,
        community: usize,
        evidence: Option<BackingApproval>,
    ) -> Result<(), LifecycleError> {
        if self.snapshot.is_some() {
            return Err(LifecycleError::Locked);
        }
        let entry = self
            .communities
            .get_mut(community)
            .ok_or(LifecycleError::InvalidCommunity)?;
        if let Some(ref approval) = evidence {
            if approval.asset != entry.asset
                || approval.evidence_hash.trim().is_empty()
                || approval.evidence_hash.len() > MAX_METADATA_BYTES
                || approval.expires_at_ms == 0
            {
                return Err(LifecycleError::InvalidApproval);
            }
        }
        entry.backing = evidence;
        Ok(())
    }

    /// Credit an already received representation transfer. The caller reads
    /// `prior_position` from its keyed store and persists the returned value.
    /// A failed call leaves the battle unchanged and the transfer refundable.
    pub fn credit(
        &mut self,
        community: usize,
        token: &AccountId,
        sender: &AccountId,
        prior_position: u128,
        amount: u128,
    ) -> Result<u128, LifecycleError> {
        if self.snapshot.is_some() {
            return Err(LifecycleError::Locked);
        }
        if self
            .communities
            .iter()
            .any(|entry| entry.audit.is_none() || entry.backing.is_none())
        {
            return Err(LifecycleError::MissingApproval);
        }
        let entry = self
            .communities
            .get_mut(community)
            .ok_or(LifecycleError::InvalidCommunity)?;
        if &entry.asset.representation != token {
            return Err(LifecycleError::WrongRepresentation);
        }
        if amount == 0 {
            return Err(LifecycleError::InvalidAmount);
        }
        let next_position = prior_position
            .checked_add(amount)
            .ok_or(LifecycleError::Overflow)?;
        let next_vault = entry
            .vault
            .checked_add(amount)
            .ok_or(LifecycleError::Overflow)?;
        entry.vault = next_vault;
        if sender == &self.fee.creator {
            self.creator_has_position = true;
        }
        Ok(next_position)
    }

    /// Record a unique winner only after authenticated scoring has resolved it.
    /// This holds the entire winning vault and exposes no disposal operation.
    pub fn hold_principal(&mut self, winner: u32) -> Result<&PrincipalHold, LifecycleError> {
        if let Some(hold) = &self.principal_hold {
            if hold.community != winner {
                return Err(LifecycleError::ConflictingWinner);
            }
        } else {
            let snapshot = self.snapshot.as_ref().ok_or(LifecycleError::NotLocked)?;
            let community = snapshot
                .communities
                .get(winner as usize)
                .ok_or(LifecycleError::InvalidCommunity)?;
            self.principal_hold = Some(PrincipalHold {
                community: winner,
                asset: community.asset.clone(),
                amount: community.vault,
            });
        }
        self.principal_hold
            .as_ref()
            .ok_or(LifecycleError::NotLocked)
    }

    /// Hold the principal of the winner established by a finished scoring run.
    /// A caller-supplied label is not accepted: the run must score the same
    /// mode and community count as this battle and must have resolved a unique
    /// winner from complete evidence. Eliminated vaults stay in the snapshot.
    pub fn hold_principal_from_scoring(
        &mut self,
        rounds: &crate::rounds::Rounds,
    ) -> Result<&PrincipalHold, LifecycleError> {
        let snapshot = self.snapshot.as_ref().ok_or(LifecycleError::NotLocked)?;
        if rounds.mode() != self.mode || rounds.community_count() != snapshot.communities.len() {
            return Err(LifecycleError::InvalidPolicy);
        }
        let winner = rounds.winner().ok_or(LifecycleError::WinnerNotResolved)?;
        self.hold_principal(winner)
    }

    /// The committed asset of a community, if it exists.
    pub fn community_asset(&self, community: usize) -> Option<&AssetIdentity> {
        self.communities.get(community).map(|entry| &entry.asset)
    }

    pub fn backing_of(&self, community: usize) -> Option<&BackingApproval> {
        self.communities
            .get(community)
            .and_then(|entry| entry.backing.as_ref())
    }

    pub fn is_locked(&self) -> bool {
        self.snapshot.is_some()
    }

    pub fn community_count(&self) -> usize {
        self.communities.len()
    }

    /// The fee snapshotted when the battle was created.
    pub fn fee_policy(&self) -> &FeePolicy {
        &self.fee
    }

    pub fn mode(&self) -> ScoringMode {
        self.mode
    }

    /// The observation policy frozen at lock, if the battle is locked.
    pub fn frozen_policy(&self) -> Option<&ObservationPolicy> {
        self.snapshot.as_ref().map(|snapshot| &snapshot.observation)
    }

    /// One identifier per original community, binding chain, token and
    /// representation account, in community order.
    pub fn asset_labels(&self) -> Vec<String> {
        self.communities
            .iter()
            .map(|community| {
                format!(
                    "{}:{}:{}",
                    community.asset.chain_id,
                    community.asset.token_address,
                    community.asset.representation
                )
            })
            .collect()
    }

    /// The held winning vault, once a unique winner has been recorded.
    pub fn principal_hold(&self) -> Option<&PrincipalHold> {
        self.principal_hold.as_ref()
    }

    /// Expose frozen losing-vault inputs without consulting any DAO decision.
    /// The future settlement adapter must enforce exclusive allocation.
    pub fn losing_vault(&self, community: u32) -> Result<LosingVault, LifecycleError> {
        let snapshot = self.snapshot.as_ref().ok_or(LifecycleError::NotLocked)?;
        let hold = self
            .principal_hold
            .as_ref()
            .ok_or(LifecycleError::WinnerNotResolved)?;
        if community == hold.community {
            return Err(LifecycleError::WinningVault);
        }
        let entry = snapshot
            .communities
            .get(community as usize)
            .ok_or(LifecycleError::InvalidCommunity)?;
        Ok(LosingVault {
            community,
            winner: hold.community,
            asset: entry.asset.clone(),
            amount: entry.vault,
            fee: snapshot.fee.clone(),
        })
    }

    /// Every community's audit and backing approval must still bind its committed
    /// asset (and the pinned audit policy, if any) and must not be expired.
    /// Fails closed.
    fn check_audit_fresh(&self, check: &LockCheck) -> Result<(), LifecycleError> {
        for entry in &self.communities {
            let approval = entry
                .audit
                .as_ref()
                .ok_or(LifecycleError::MissingApproval)?;
            if approval.asset != entry.asset {
                return Err(LifecycleError::ApprovalMismatch);
            }
            if let Some(required) = &check.required_policy_hash {
                if &approval.policy_hash != required {
                    return Err(LifecycleError::ApprovalMismatch);
                }
            }
            if check.now_ms >= approval.expires_at_ms {
                return Err(LifecycleError::ExpiredApproval);
            }
            let backing = entry
                .backing
                .as_ref()
                .ok_or(LifecycleError::MissingApproval)?;
            if backing.asset != entry.asset {
                return Err(LifecycleError::ApprovalMismatch);
            }
            if check.now_ms >= backing.expires_at_ms {
                return Err(LifecycleError::ExpiredApproval);
            }
        }
        Ok(())
    }

    /// The adapter must revalidate approval and backing before lock. Once
    /// frozen, duplicate lock calls return the original snapshot unchanged.
    pub fn lock(
        &mut self,
        observation: ObservationPolicy,
        check: &LockCheck,
    ) -> Result<&Snapshot, LifecycleError> {
        if self.snapshot.is_none() {
            if !observation.is_valid() {
                return Err(LifecycleError::InvalidPolicy);
            }
            if self
                .communities
                .iter()
                .any(|entry| entry.audit.is_none() || entry.backing.is_none())
            {
                return Err(LifecycleError::MissingApproval);
            }
            self.check_audit_fresh(check)?;
            if self.communities.iter().any(|entry| entry.vault == 0) {
                return Err(LifecycleError::EmptyVault);
            }
            if !self.creator_has_position {
                return Err(LifecycleError::CreatorHasNoPosition);
            }
            self.snapshot = Some(Snapshot {
                communities: self.communities.clone(),
                mode: self.mode,
                fee: self.fee.clone(),
                observation,
                creator_participated: self.creator_has_position,
            });
        }
        self.snapshot.as_ref().ok_or(LifecycleError::InvalidPolicy)
    }
}

// Internal storage adapter. These methods are deliberately outside #[near]:
// public Rust visibility does not expose a contract method. Authentication,
// storage payment, approval verification and NEP-141 handling remain for the
// contract-facing adapter.
impl crate::Arena {
    pub fn lifecycle_insert(&mut self, battle: Battle) -> Result<u64, LifecycleError> {
        let id = self
            .lifecycle_battle_count
            .checked_add(1)
            .ok_or(LifecycleError::Overflow)?;
        self.lifecycle_battles.insert(id, battle);
        self.lifecycle_battle_count = id;
        Ok(id)
    }

    pub fn lifecycle_set_audit(
        &mut self,
        id: u64,
        community: usize,
        evidence: Option<AuditApproval>,
    ) -> Result<(), LifecycleError> {
        let mut battle = self
            .lifecycle_battles
            .get(&id)
            .cloned()
            .ok_or(LifecycleError::UnknownBattle)?;
        battle.set_audit(community, evidence)?;
        self.lifecycle_battles.insert(id, battle);
        Ok(())
    }

    pub fn lifecycle_set_backing(
        &mut self,
        id: u64,
        community: usize,
        evidence: Option<BackingApproval>,
    ) -> Result<(), LifecycleError> {
        let mut battle = self
            .lifecycle_battles
            .get(&id)
            .cloned()
            .ok_or(LifecycleError::UnknownBattle)?;
        battle.set_backing(community, evidence)?;
        self.lifecycle_battles.insert(id, battle);
        Ok(())
    }

    pub fn lifecycle_register_position(
        &mut self,
        id: u64,
        community: u32,
        account: &AccountId,
    ) -> Result<(), LifecycleError> {
        let battle = self
            .lifecycle_battles
            .get(&id)
            .ok_or(LifecycleError::UnknownBattle)?;
        battle.can_register_position(community)?;
        let key = (id, community, account.clone());
        if self.lifecycle_positions.contains_key(&key) {
            return Err(LifecycleError::PositionAlreadyRegistered);
        }
        self.lifecycle_positions.insert(key, 0);
        Ok(())
    }

    /// Add an account to a community's participant index the first time it
    /// holds a credited deposit. Registering a position alone adds nothing, so
    /// accounts that never deposit cannot enlarge the settlement workload.
    fn lifecycle_index_participant(
        &mut self,
        id: u64,
        community: u32,
        account: &AccountId,
    ) -> Result<(), LifecycleError> {
        let count = self
            .lifecycle_participant_counts
            .get(&(id, community))
            .copied()
            .unwrap_or(0);
        if count >= MAX_PARTICIPANTS_PER_COMMUNITY {
            return Err(LifecycleError::TooManyParticipants);
        }
        self.lifecycle_participants
            .insert((id, community, count), account.clone());
        self.lifecycle_participant_counts
            .insert((id, community), count + 1);
        Ok(())
    }

    /// Credited deposits of every participant of a community, in registration
    /// order, omitting registered accounts that hold nothing.
    pub fn lifecycle_participant_positions(
        &self,
        id: u64,
        community: u32,
    ) -> Vec<(AccountId, u128)> {
        let count = self
            .lifecycle_participant_counts
            .get(&(id, community))
            .copied()
            .unwrap_or(0);
        (0..count)
            .filter_map(|index| self.lifecycle_participants.get(&(id, community, index)))
            .filter_map(|account| {
                let deposit = self.lifecycle_position(id, community, account);
                (deposit > 0).then(|| (account.clone(), deposit))
            })
            .collect()
    }

    pub fn lifecycle_credit(
        &mut self,
        id: u64,
        community: u32,
        token: &AccountId,
        sender: &AccountId,
        amount: u128,
    ) -> Result<(), LifecycleError> {
        let mut battle = self
            .lifecycle_battles
            .get(&id)
            .cloned()
            .ok_or(LifecycleError::UnknownBattle)?;
        let key = (id, community, sender.clone());
        let prior = self
            .lifecycle_positions
            .get(&key)
            .copied()
            .ok_or(LifecycleError::PositionNotRegistered)?;
        let next = battle.credit(community as usize, token, sender, prior, amount)?;
        if prior == 0 && next > 0 {
            self.lifecycle_index_participant(id, community, sender)?;
        }
        self.lifecycle_positions.insert(key, next);
        self.lifecycle_battles.insert(id, battle);
        Ok(())
    }

    pub fn lifecycle_lock(
        &mut self,
        id: u64,
        policy: ObservationPolicy,
    ) -> Result<Snapshot, LifecycleError> {
        let check = LockCheck {
            now_ms: near_sdk::env::block_timestamp_ms(),
            required_policy_hash: self.lifecycle_audit_policy_hash.clone(),
        };
        let mut battle = self
            .lifecycle_battles
            .get(&id)
            .cloned()
            .ok_or(LifecycleError::UnknownBattle)?;
        let snapshot = battle.lock(policy, &check)?.clone();
        self.lifecycle_battles.insert(id, battle);
        Ok(snapshot)
    }

    /// Internal only: scoring must authenticate the unique winner before calling.
    pub fn lifecycle_hold_principal(
        &mut self,
        id: u64,
        winner: u32,
    ) -> Result<PrincipalHold, LifecycleError> {
        let mut battle = self
            .lifecycle_battles
            .get(&id)
            .cloned()
            .ok_or(LifecycleError::UnknownBattle)?;
        let hold = battle.hold_principal(winner)?.clone();
        self.lifecycle_battles.insert(id, battle);
        self.lifecycle_winner_at
            .insert(id, near_sdk::env::block_timestamp());
        Ok(hold)
    }

    /// Rust-only read boundary for the future settlement integration.
    pub fn lifecycle_losing_vault(
        &self,
        id: u64,
        community: u32,
    ) -> Result<LosingVault, LifecycleError> {
        self.lifecycle_battles
            .get(&id)
            .ok_or(LifecycleError::UnknownBattle)?
            .losing_vault(community)
    }

    pub fn lifecycle_position(&self, id: u64, community: u32, account: &AccountId) -> u128 {
        self.lifecycle_positions
            .get(&(id, community, account.clone()))
            .copied()
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn account(name: &str) -> AccountId {
        name.parse().expect("valid account")
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
    fn fee() -> FeePolicy {
        FeePolicy {
            fee_bps: 10,
            creator_share_bps: 5000,
            creator: account("creator.testnet"),
            protocol: account("protocol.testnet"),
            protocol_created: false,
        }
    }
    fn policy(hash: &str) -> ObservationPolicy {
        ObservationPolicy {
            version: 1,
            policy_hash: hash.into(),
        }
    }
    fn battle() -> Battle {
        Battle::new(
            vec![asset(1), asset(2), asset(3)],
            ScoringMode::PriceGain,
            fee(),
        )
        .expect("battle")
    }
    fn audit(index: usize) -> AuditApproval {
        AuditApproval {
            asset: asset(index as u8 + 1),
            policy_hash: "policy".into(),
            evidence_hash: format!("audit-{index}"),
            expires_at_ms: FAR,
        }
    }
    const FAR: u64 = 1_000_000_000_000;
    fn ck() -> LockCheck {
        LockCheck {
            now_ms: 0,
            required_policy_hash: None,
        }
    }
    fn backing(index: usize) -> BackingApproval {
        BackingApproval {
            asset: asset(index as u8 + 1),
            evidence_hash: format!("backing-{index}"),
            expires_at_ms: FAR,
        }
    }
    fn approve(b: &mut Battle) {
        for i in 0..3 {
            b.set_audit(i, Some(audit(i))).expect("audit");
            b.set_backing(i, Some(backing(i))).expect("backing");
        }
    }
    fn deposit(
        b: &mut Battle,
        index: usize,
        who: &str,
        prior: u128,
        amount: u128,
    ) -> Result<u128, LifecycleError> {
        b.credit(
            index,
            &asset(index as u8 + 1).representation,
            &account(who),
            prior,
            amount,
        )
    }

    #[test]
    fn three_vaults_freeze_and_late_changes_do_not_mutate_snapshot() {
        let mut b = battle();
        approve(&mut b);
        assert_eq!(deposit(&mut b, 0, "creator.testnet", 0, 7), Ok(7));
        assert_eq!(deposit(&mut b, 1, "other.testnet", 0, 11), Ok(11));
        assert_eq!(deposit(&mut b, 2, "other.testnet", 0, 13), Ok(13));
        let frozen = b.lock(policy("original"), &ck()).expect("lock").clone();
        assert_eq!(
            frozen
                .communities
                .iter()
                .map(|c| c.vault)
                .collect::<Vec<_>>(),
            vec![7, 11, 13]
        );
        assert_eq!(
            deposit(&mut b, 0, "creator.testnet", 7, 5),
            Err(LifecycleError::Locked)
        );
        assert_eq!(b.set_audit(0, None), Err(LifecycleError::Locked));
        assert_eq!(b.lock(policy("changed"), &ck()), Ok(&frozen));
    }

    #[test]
    fn snapshot_freezes_identities_mode_fee_policy_and_creator_participation() {
        let mut b = battle();
        approve(&mut b);
        deposit(&mut b, 0, "creator.testnet", 0, 7).expect("credit");
        deposit(&mut b, 1, "other.testnet", 0, 11).expect("credit");
        deposit(&mut b, 2, "other.testnet", 0, 13).expect("credit");
        let frozen = b.lock(policy("original"), &ck()).expect("lock").clone();
        assert_eq!(
            frozen
                .communities
                .iter()
                .map(|c| c.asset.clone())
                .collect::<Vec<_>>(),
            vec![asset(1), asset(2), asset(3)]
        );
        assert_eq!(frozen.mode, ScoringMode::PriceGain);
        assert_eq!(frozen.fee, fee());
        assert_eq!(frozen.observation, policy("original"));
        assert!(frozen.creator_participated);
        // Nothing the battle exposes can alter the frozen record afterwards.
        assert_eq!(b.set_audit(0, None), Err(LifecycleError::Locked));
        assert_eq!(b.set_backing(0, None), Err(LifecycleError::Locked));
        assert_eq!(
            deposit(&mut b, 2, "creator.testnet", 0, 1),
            Err(LifecycleError::Locked)
        );
        assert_eq!(b.lock(policy("other"), &ck()), Ok(&frozen));
        assert_eq!(b.view().communities[0].vault, U128(7));
    }

    #[test]
    fn withdrawn_evidence_holds_lock_and_does_not_change_vaults() {
        let mut b = battle();
        approve(&mut b);
        deposit(&mut b, 0, "creator.testnet", 0, 7).expect("credit");
        deposit(&mut b, 1, "other.testnet", 0, 11).expect("credit");
        deposit(&mut b, 2, "other.testnet", 0, 13).expect("credit");
        b.set_backing(1, None).expect("withdraw evidence");
        assert_eq!(
            b.lock(policy("p"), &ck()),
            Err(LifecycleError::MissingApproval)
        );
        assert_eq!(b.communities[1].vault, 11);
        assert_eq!(
            deposit(&mut b, 0, "creator.testnet", 7, 1),
            Err(LifecycleError::MissingApproval)
        );
        b.set_backing(1, Some(backing(1)))
            .expect("restore evidence");
        assert_eq!(
            b.lock(policy("p"), &ck()).expect("lock").communities[1].vault,
            11
        );
        assert_eq!(b.set_backing(1, None), Err(LifecycleError::Locked));
    }

    #[test]
    fn no_creator_stake_or_empty_vault_cannot_lock() {
        let mut b = battle();
        approve(&mut b);
        for i in 0..3 {
            deposit(&mut b, i, "other.testnet", 0, 1).expect("credit");
        }
        assert_eq!(
            b.lock(policy("p"), &ck()),
            Err(LifecycleError::CreatorHasNoPosition)
        );
        let mut b = battle();
        approve(&mut b);
        deposit(&mut b, 0, "creator.testnet", 0, 1).expect("credit");
        assert_eq!(b.lock(policy("p"), &ck()), Err(LifecycleError::EmptyVault));
    }

    #[test]
    fn invalid_transfers_and_overflow_are_atomic() {
        let mut b = battle();
        approve(&mut b);
        let before = b.clone();
        assert_eq!(
            b.credit(
                0,
                &asset(2).representation,
                &account("creator.testnet"),
                0,
                1
            ),
            Err(LifecycleError::WrongRepresentation)
        );
        assert_eq!(
            deposit(&mut b, 0, "creator.testnet", u128::MAX, 1),
            Err(LifecycleError::Overflow)
        );
        assert_eq!(b, before);
        deposit(&mut b, 0, "creator.testnet", 0, u128::MAX).expect("credit");
        let before = b.clone();
        assert_eq!(
            deposit(&mut b, 0, "other.testnet", 0, 1),
            Err(LifecycleError::Overflow)
        );
        assert_eq!(b, before);
    }

    #[test]
    fn approval_must_bind_asset_and_both_evidence_sources() {
        let mut b = battle();
        assert_eq!(
            b.set_audit(0, Some(audit(1))),
            Err(LifecycleError::InvalidApproval)
        );
        assert_eq!(
            b.set_backing(0, Some(backing(1))),
            Err(LifecycleError::InvalidApproval)
        );
        let mut missing = backing(0);
        missing.evidence_hash.clear();
        assert_eq!(
            b.set_backing(0, Some(missing)),
            Err(LifecycleError::InvalidApproval)
        );
        let mut missing = audit(0);
        missing.policy_hash.clear();
        assert_eq!(
            b.set_audit(0, Some(missing)),
            Err(LifecycleError::InvalidApproval)
        );
        for i in 0..3 {
            b.set_audit(i, Some(audit(i))).expect("audit");
        }
        assert_eq!(
            deposit(&mut b, 0, "creator.testnet", 0, 1),
            Err(LifecycleError::MissingApproval)
        );
    }

    #[test]
    fn external_u64_values_are_lossless_json_strings() {
        let raw = near_sdk::serde_json::json!({"chain_id": "9007199254740993", "token_address": "0x0000000000000000000000000000000000000001", "representation": "token.testnet", "custody_domain": "fixture"});
        let input: AssetInput = near_sdk::serde_json::from_value(raw).expect("asset input");
        assert_eq!(AssetIdentity::from(input).chain_id, 9_007_199_254_740_993);
        let policy: ObservationPolicyInput = near_sdk::serde_json::from_value(
            near_sdk::serde_json::json!({"version": "9007199254740993", "policy_hash": "p"}),
        )
        .expect("policy input");
        assert_eq!(
            ObservationPolicy::from(policy).version,
            9_007_199_254_740_993
        );
    }

    #[test]
    fn community_count_and_metadata_are_bounded() {
        let assets = (1..=16).map(asset).collect::<Vec<_>>();
        assert!(Battle::new(assets, ScoringMode::PriceGain, fee()).is_ok());
        let assets = (1..=17).map(asset).collect::<Vec<_>>();
        assert_eq!(
            Battle::new(assets, ScoringMode::PriceGain, fee()),
            Err(LifecycleError::TooManyCommunities)
        );
        let mut long = asset(1);
        long.custody_domain = "x".repeat(MAX_METADATA_BYTES + 1);
        assert_eq!(
            Battle::new(vec![long, asset(2)], ScoringMode::PriceGain, fee()),
            Err(LifecycleError::InvalidAsset)
        );
        let mut b = battle();
        let mut long_audit = audit(0);
        long_audit.evidence_hash = "x".repeat(MAX_METADATA_BYTES + 1);
        assert_eq!(
            b.set_audit(0, Some(long_audit)),
            Err(LifecycleError::InvalidApproval)
        );
        let mut long_backing = backing(0);
        long_backing.evidence_hash = "x".repeat(MAX_METADATA_BYTES + 1);
        assert_eq!(
            b.set_backing(0, Some(long_backing)),
            Err(LifecycleError::InvalidApproval)
        );
    }

    #[test]
    fn rejects_malformed_evm_asset_identity() {
        for address in [
            "",
            "0x01",
            "0xgg00000000000000000000000000000000000000",
            " 0x0000000000000000000000000000000000000001",
        ] {
            let mut bad = asset(1);
            bad.token_address = address.into();
            assert_eq!(
                Battle::new(vec![bad, asset(2)], ScoringMode::PriceGain, fee()),
                Err(LifecycleError::InvalidAsset)
            );
        }
        let mut bad = asset(1);
        bad.custody_domain = " ".into();
        assert_eq!(
            Battle::new(vec![bad, asset(2)], ScoringMode::PriceGain, fee()),
            Err(LifecycleError::InvalidAsset)
        );
    }

    #[test]
    fn rejects_duplicate_identity_and_unauthorized_protocol_label() {
        let mut duplicate = asset(2);
        duplicate.token_address = asset(1).token_address.to_ascii_uppercase();
        assert_eq!(
            Battle::new(vec![asset(1), duplicate], ScoringMode::PriceGain, fee()),
            Err(LifecycleError::DuplicateAsset)
        );
        let mut protocol_fee = fee();
        protocol_fee.protocol_created = true;
        assert_eq!(
            Battle::new(
                vec![asset(1), asset(2)],
                ScoringMode::PriceGain,
                protocol_fee
            ),
            Err(LifecycleError::InvalidPolicy)
        );
    }

    #[test]
    fn losing_vault_inputs_are_available_without_a_dao_decision() {
        let mut b = battle();
        approve(&mut b);
        deposit(&mut b, 0, "creator.testnet", 0, 7).expect("credit");
        deposit(&mut b, 1, "other.testnet", 0, 11).expect("credit");
        deposit(&mut b, 2, "other.testnet", 0, 13).expect("credit");
        b.lock(policy("p"), &ck()).expect("lock");
        assert_eq!(b.losing_vault(1), Err(LifecycleError::WinnerNotResolved));
        b.hold_principal(0).expect("hold");
        let first = b.losing_vault(1).expect("loser");
        assert_eq!(first.amount, 11);
        assert_eq!(first.asset, asset(2));
        assert_eq!(first.fee, fee());
        assert_eq!(b.losing_vault(2).expect("loser").amount, 13);
        assert_eq!(b.losing_vault(0), Err(LifecycleError::WinningVault));
        assert_eq!(b.losing_vault(1), Ok(first));
        assert_eq!(b.principal_hold.as_ref().expect("hold").amount, 7);
    }

    #[test]
    fn only_a_scored_unique_winner_holds_principal_and_eliminated_vaults_stay_locked() {
        use crate::rounds::{
            CandidateObservation, ModeData, ObservationTerms, Resolution, RoundError, Rounds,
            ROUND_NS,
        };
        use crate::scoring::{ObservationContext, ObservationEvidence};
        let terms = ObservationTerms {
            source: "source".into(),
            quote_currency: "USD".into(),
            eligible_pools: vec!["pool".into()],
            finality: "finalized".into(),
            price_decimals: 6,
            supply_decimals: 2,
            volume_decimals: 8,
            boundary_tolerance_ns: 0,
            max_gap_ns: ROUND_NS,
        };
        let mut b = battle();
        approve(&mut b);
        deposit(&mut b, 0, "creator.testnet", 0, 7).expect("credit");
        deposit(&mut b, 1, "other.testnet", 0, 11).expect("credit");
        deposit(&mut b, 2, "other.testnet", 0, 13).expect("credit");
        // Only the digest of the terms is committed at lock.
        let frozen = b
            .lock(
                ObservationPolicy {
                    version: 1,
                    policy_hash: terms.digest(ScoringMode::PriceGain),
                },
                &ck(),
            )
            .expect("lock")
            .observation
            .clone();
        let assets = |count: usize| (0..count).map(|i| format!("asset-{i}")).collect::<Vec<_>>();
        let mut rounds = Rounds::from_frozen_policy(
            1,
            ScoringMode::PriceGain,
            &frozen.policy_hash,
            &terms,
            assets(3),
        )
        .expect("rounds");
        // No result yet: nothing is held and a wrong-shaped run is refused.
        assert_eq!(
            b.hold_principal_from_scoring(&rounds),
            Err(LifecycleError::WinnerNotResolved)
        );
        let two = Rounds::from_frozen_policy(
            1,
            ScoringMode::PriceGain,
            &frozen.policy_hash,
            &terms,
            assets(2),
        )
        .expect("two");
        // Terms that were not the ones committed at lock cannot start rounds.
        let mut swapped = terms.clone();
        swapped.source = "other source".into();
        assert_eq!(
            Rounds::from_frozen_policy(
                1,
                ScoringMode::PriceGain,
                &frozen.policy_hash,
                &swapped,
                assets(3)
            )
            .err(),
            Some(RoundError::PolicyMismatch)
        );
        assert_eq!(
            b.hold_principal_from_scoring(&two),
            Err(LifecycleError::InvalidPolicy)
        );
        let observe = |rounds: &Rounds, round: u64, community: u32, end: u128| {
            let (start_ns, end_ns) = rounds.window().expect("open");
            CandidateObservation {
                community,
                evidence: ObservationEvidence {
                    context: ObservationContext {
                        battle_id: 1,
                        round_id: round,
                        asset_id: format!("asset-{community}"),
                        source: "source".into(),
                        policy_hash: frozen.policy_hash.clone(),
                        start_ns,
                        end_ns,
                    },
                    observed_times_ns: vec![start_ns, end_ns],
                    evidence_hash: "h".into(),
                },
                data: ModeData::Price { start: 100, end },
            }
        };
        rounds.open_round(1, 1_000).expect("open");
        let tie = [
            observe(&rounds, 1, 0, 110),
            observe(&rounds, 1, 1, 110),
            observe(&rounds, 1, 2, 102),
        ];
        assert_eq!(
            rounds.resolve_round(1, &tie),
            Ok(Resolution::Overtime {
                next_candidates: vec![0, 1]
            })
        );
        // After a tie there is still no winner; every vault is still intact.
        assert_eq!(
            b.hold_principal_from_scoring(&rounds),
            Err(LifecycleError::WinnerNotResolved)
        );
        assert_eq!(b.losing_vault(2), Err(LifecycleError::WinnerNotResolved));
        assert_eq!(
            rounds.open_round(2, 1_000),
            Err(RoundError::StartsBeforePreviousEnd)
        );
        rounds.open_round(2, 1_000 + ROUND_NS).expect("open 2");
        let fin = [observe(&rounds, 2, 0, 96), observe(&rounds, 2, 1, 95)];
        assert_eq!(rounds.resolve_round(2, &fin), Ok(Resolution::Winner(0)));
        let hold = b
            .hold_principal_from_scoring(&rounds)
            .expect("hold")
            .clone();
        assert_eq!((hold.community, hold.amount), (0, 7));
        // The eliminated and the earlier-tied loser both retain their full vaults.
        assert_eq!(b.losing_vault(2).expect("eliminated").amount, 13);
        assert_eq!(b.losing_vault(1).expect("loser").amount, 11);
    }

    #[test]
    fn every_original_vault_settles_separately_including_eliminated_communities() {
        use crate::settlement::{allocate_battle, Recipient, SettlementError};
        let mut b = battle();
        approve(&mut b);
        deposit(&mut b, 0, "creator.testnet", 0, 600).expect("credit");
        deposit(&mut b, 0, "other.testnet", 0, 400).expect("credit");
        deposit(&mut b, 1, "other.testnet", 0, 100_000).expect("credit");
        deposit(&mut b, 2, "other.testnet", 0, 200_000).expect("credit");
        b.lock(policy("p"), &ck()).expect("lock");
        let winners = vec![
            (account("creator.testnet"), 600),
            (account("other.testnet"), 400),
        ];
        // No recorded winner yet: nothing can be allocated.
        assert_eq!(
            allocate_battle(1, &b, &winners),
            Err(SettlementError::InvalidInput)
        );
        b.hold_principal(0).expect("hold");
        let allocations = allocate_battle(1, &b, &winners).expect("allocate");
        assert_eq!(
            allocations.iter().map(|a| a.community).collect::<Vec<_>>(),
            vec![1, 2]
        );
        let total = |a: &crate::settlement::VaultAllocation, kind: Recipient| {
            a.entitlements
                .iter()
                .filter(|e| e.kind == kind)
                .map(|e| e.amount)
                .sum::<u128>()
        };
        // Each losing token keeps its own amounts and fees: 100000 -> 99900+50+50, 200000 -> 199800+100+100.
        assert_eq!(total(&allocations[0], Recipient::Winner), 99_900);
        assert_eq!(total(&allocations[1], Recipient::Winner), 199_800);
        assert_eq!(total(&allocations[1], Recipient::Creator), 100);
        assert_eq!(total(&allocations[1], Recipient::Protocol), 100);
        // Repeating produces identical identities, so a retry cannot allocate twice.
        assert_eq!(allocate_battle(1, &b, &winners), Ok(allocations.clone()));
        // Weights that do not match the held winning vault are refused.
        assert_eq!(
            allocate_battle(1, &b, &winners[..1]),
            Err(SettlementError::InvalidInput)
        );
    }

    #[test]
    fn principal_hold_requires_lock_and_cannot_change_winner() {
        let mut b = battle();
        assert_eq!(b.hold_principal(0), Err(LifecycleError::NotLocked));
        approve(&mut b);
        deposit(&mut b, 0, "creator.testnet", 0, 7).expect("credit");
        deposit(&mut b, 1, "other.testnet", 0, 11).expect("credit");
        deposit(&mut b, 2, "other.testnet", 0, 13).expect("credit");
        b.lock(policy("p"), &ck()).expect("lock");
        assert_eq!(b.hold_principal(3), Err(LifecycleError::InvalidCommunity));
        let hold = b.hold_principal(1).expect("hold").clone();
        assert_eq!(hold.asset, asset(2));
        assert_eq!(hold.amount, 11);
        assert_eq!(b.hold_principal(1), Ok(&hold));
        assert_eq!(b.hold_principal(0), Err(LifecycleError::ConflictingWinner));
        assert_eq!(b.hold_principal(1), Ok(&hold));
    }

    #[test]
    fn receiver_credits_only_registered_approved_tokens_and_refunds_late_transfers() {
        use near_sdk::json_types::{U128, U64};
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::{testing_env, NearToken, PromiseOrValue};
        fn returned(value: PromiseOrValue<U128>) -> u128 {
            match value {
                PromiseOrValue::Value(value) => value.0,
                PromiseOrValue::Promise(_) => panic!("unexpected promise"),
            }
        }
        let mut context = VMContextBuilder::new();
        context.predecessor_account_id(account("owner.testnet"));
        testing_env!(context.build());
        let mut arena = crate::Arena::new(
            account("owner.testnet"),
            account("usdc.testnet"),
            account("treasury.testnet"),
            U128(0),
            U64(60),
        );
        arena.add_agent(account("worker.testnet"));
        context.attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(context.build());
        arena.activate_lifecycle();
        arena.set_lifecycle_observation_policy(policy("p").into());
        let id = arena.lifecycle_insert(battle()).expect("battle");
        let creator = account("creator.testnet");
        let other = account("other.testnet");
        for (community, sender) in [(0, &creator), (1, &other), (2, &other)] {
            context
                .predecessor_account_id(sender.clone())
                .attached_deposit(NearToken::from_near(1));
            testing_env!(context.build());
            arena.register_lifecycle_position(id, community);
        }
        let msg = |community| {
            format!(r#"{{"action":"lifecycle_deposit","battle_id":{id},"community":{community}}}"#)
        };
        context
            .predecessor_account_id(asset(1).representation)
            .attached_deposit(NearToken::from_yoctonear(0));
        testing_env!(context.build());
        assert_eq!(
            returned(arena.ft_on_transfer(creator.clone(), U128(7), msg(0))),
            7
        );
        for i in 0..3 {
            arena
                .lifecycle_set_audit(id, i, Some(audit(i)))
                .expect("audit fixture");
            arena
                .lifecycle_set_backing(id, i, Some(backing(i)))
                .expect("backing fixture");
        }
        assert_eq!(
            returned(arena.ft_on_transfer(creator.clone(), U128(7), msg(1))),
            7
        );
        assert_eq!(
            returned(arena.ft_on_transfer(creator.clone(), U128(7), msg(0))),
            0
        );
        for i in 1..3 {
            context.predecessor_account_id(asset(i as u8 + 1).representation);
            testing_env!(context.build());
            assert_eq!(
                returned(arena.ft_on_transfer(other.clone(), U128(10), msg(i))),
                0
            );
        }
        context
            .predecessor_account_id(account("worker.testnet"))
            .attached_deposit(NearToken::from_near(1));
        testing_env!(context.build());
        arena.lock_lifecycle_battle(id);
        let frozen = arena
            .lifecycle_battles
            .get(&id)
            .expect("battle")
            .snapshot
            .clone()
            .expect("snapshot");
        context
            .predecessor_account_id(account("owner.testnet"))
            .attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(context.build());
        arena.set_lifecycle_observation_policy(policy("changed").into());
        context.predecessor_account_id(account("worker.testnet"));
        testing_env!(context.build());
        arena.lock_lifecycle_battle(id);
        context.predecessor_account_id(asset(1).representation);
        testing_env!(context.build());
        assert_eq!(
            returned(arena.ft_on_transfer(creator.clone(), U128(9), msg(0))),
            9
        );
        assert_eq!(arena.lifecycle_position(id, 0, &creator), 7);
        let view = arena.get_lifecycle_battle(id).expect("view");
        assert!(view.locked);
        assert_eq!(view.observation_policy_hash.as_deref(), Some("p"));
        assert_eq!(view.communities[0].vault, U128(7));
        let json = near_sdk::serde_json::to_value(&view).expect("JSON");
        assert_eq!(json["communities"][0]["vault"], "7");
        assert_eq!(json["communities"][0]["chain_id"], "46630");
        let position = arena.get_lifecycle_position(id, 0, creator.clone());
        assert!(position.registered);
        assert_eq!(position.amount, U128(7));
        assert!(
            !arena
                .get_lifecycle_position(id, 0, other.clone())
                .registered
        );
        assert_eq!(arena.lifecycle_lock(id, policy("changed")), Ok(frozen));
    }

    #[test]
    fn contract_creation_is_bond_free_and_snapshots_protocol_identity() {
        use near_sdk::json_types::{U128, U64};
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::{testing_env, NearToken};
        let mut context = VMContextBuilder::new();
        context.predecessor_account_id(account("owner.testnet"));
        testing_env!(context.build());
        let mut arena = crate::Arena::new(
            account("owner.testnet"),
            account("usdc.testnet"),
            account("treasury.testnet"),
            U128(5_000_000),
            U64(60),
        );
        context.attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(context.build());
        arena.activate_lifecycle();
        arena.set_lifecycle_protocol(account("protocol.testnet"));
        context
            .predecessor_account_id(account("creator.testnet"))
            .attached_deposit(NearToken::from_near(1));
        testing_env!(context.build());
        let id = arena.create_lifecycle_battle(
            vec![asset(1).into(), asset(2).into()],
            ScoringMode::PriceGain,
        );
        let battle = arena.lifecycle_battles.get(&id).expect("stored");
        assert_eq!(battle.fee.creator, account("creator.testnet"));
        assert_eq!(battle.fee.protocol, account("protocol.testnet"));
        assert!(!battle.fee.protocol_created);
        assert_eq!(battle.fee.fee_bps, 10);
        assert!(battle
            .communities
            .iter()
            .all(|community| community.audit.is_none() && community.backing.is_none()));
        assert_eq!(
            arena.lifecycle_position(id, 0, &account("creator.testnet")),
            0
        );
    }

    #[test]
    fn only_depositors_enter_the_participant_index_and_their_number_is_capped() {
        use near_sdk::json_types::{U128, U64};
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::testing_env;
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(account("owner.testnet"))
            .build());
        let mut arena = crate::Arena::new(
            account("owner.testnet"),
            account("usdc.testnet"),
            account("treasury.testnet"),
            U128(0),
            U64(60),
        );
        let id = arena.lifecycle_insert(battle()).expect("battle");
        for index in 0..3 {
            arena
                .lifecycle_set_audit(id, index, Some(audit(index)))
                .expect("audit");
            arena
                .lifecycle_set_backing(id, index, Some(backing(index)))
                .expect("backing");
        }
        // Registering a position alone adds nobody to the index.
        let people: Vec<AccountId> = (0..3).map(|i| account(&format!("p{i}.testnet"))).collect();
        for person in &people {
            arena
                .lifecycle_register_position(id, 0, person)
                .expect("register");
        }
        assert!(arena.lifecycle_participant_positions(id, 0).is_empty());
        let token = asset(1).representation;
        arena
            .lifecycle_credit(id, 0, &token, &people[0], 5)
            .expect("credit");
        arena
            .lifecycle_credit(id, 0, &token, &people[2], 5)
            .expect("credit");
        // A top-up by an existing depositor does not add a second entry.
        arena
            .lifecycle_credit(id, 0, &token, &people[0], 1)
            .expect("top up");
        assert_eq!(
            arena.lifecycle_participant_positions(id, 0),
            vec![(people[0].clone(), 6), (people[2].clone(), 5)]
        );
        // Depositors per community are capped, but existing ones can still top up.
        let token = asset(2).representation;
        let crowd: Vec<AccountId> = (0..=MAX_PARTICIPANTS_PER_COMMUNITY)
            .map(|i| account(&format!("u{i}.testnet")))
            .collect();
        for person in &crowd {
            arena
                .lifecycle_register_position(id, 1, person)
                .expect("register");
        }
        for person in &crowd[..MAX_PARTICIPANTS_PER_COMMUNITY as usize] {
            arena
                .lifecycle_credit(id, 1, &token, person, 1)
                .expect("credit");
        }
        assert_eq!(
            arena.lifecycle_credit(
                id,
                1,
                &token,
                &crowd[MAX_PARTICIPANTS_PER_COMMUNITY as usize],
                1
            ),
            Err(LifecycleError::TooManyParticipants)
        );
        assert_eq!(arena.lifecycle_credit(id, 1, &token, &crowd[0], 1), Ok(()));
        assert_eq!(
            arena.lifecycle_participant_positions(id, 1).len(),
            MAX_PARTICIPANTS_PER_COMMUNITY as usize
        );
    }

    #[test]
    fn only_the_protocol_changes_fees_within_bounds_and_only_for_future_battles() {
        use near_sdk::json_types::{U128, U64};
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::{testing_env, NearToken};
        let caller = |name: &str, deposit: NearToken| {
            testing_env!(VMContextBuilder::new()
                .predecessor_account_id(account(name))
                .attached_deposit(deposit)
                .build());
        };
        let panics = |f: &mut dyn FnMut()| {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
        };
        caller("owner.testnet", NearToken::from_yoctonear(0));
        let mut arena = crate::Arena::new(
            account("owner.testnet"),
            account("usdc.testnet"),
            account("treasury.testnet"),
            U128(0),
            U64(60),
        );
        caller("owner.testnet", NearToken::from_yoctonear(1));
        arena.activate_lifecycle();
        // No protocol account yet: nobody can change fees.
        assert!(panics(&mut || arena.set_lifecycle_fee(20, 5_000)));
        arena.set_lifecycle_protocol(account("protocol.testnet"));
        assert_eq!(arena.get_lifecycle_fee(), (10, 5_000));
        let create = |arena: &mut crate::Arena| {
            caller("creator.testnet", NearToken::from_near(1));
            arena.create_lifecycle_battle(
                vec![asset(1).into(), asset(2).into()],
                ScoringMode::PriceGain,
            )
        };
        let first = create(&mut arena);
        // The arena owner is not the protocol and cannot change the fee.
        caller("owner.testnet", NearToken::from_yoctonear(1));
        assert!(panics(&mut || arena.set_lifecycle_fee(20, 5_000)));
        caller("creator.testnet", NearToken::from_yoctonear(1));
        assert!(panics(&mut || arena.set_lifecycle_fee(20, 5_000)));
        // The protocol can, within bounds: at most 1000 bps in total, 10000 for the share.
        caller("protocol.testnet", NearToken::from_yoctonear(1));
        assert!(panics(&mut || arena.set_lifecycle_fee(1_001, 5_000)));
        assert!(panics(&mut || arena.set_lifecycle_fee(10, 10_001)));
        caller("protocol.testnet", NearToken::from_yoctonear(0));
        assert!(panics(&mut || arena.set_lifecycle_fee(20, 5_000)));
        assert_eq!(arena.get_lifecycle_fee(), (10, 5_000));
        caller("protocol.testnet", NearToken::from_yoctonear(1));
        arena.set_lifecycle_fee(1_000, 10_000);
        assert_eq!(arena.get_lifecycle_fee(), (1_000, 10_000));
        arena.set_lifecycle_fee(0, 0);
        assert_eq!(arena.get_lifecycle_fee(), (0, 0));
        arena.set_lifecycle_fee(25, 2_500);
        // The earlier battle keeps its snapshot; a new one uses the new settings.
        let second = create(&mut arena);
        let old = arena.lifecycle_battles.get(&first).expect("first");
        let new = arena.lifecycle_battles.get(&second).expect("second");
        assert_eq!(
            (old.fee_policy().fee_bps, old.fee_policy().creator_share_bps),
            (10, 5_000)
        );
        assert_eq!(
            (new.fee_policy().fee_bps, new.fee_policy().creator_share_bps),
            (25, 2_500)
        );
    }

    #[test]
    #[should_panic(expected = "Insufficient storage deposit")]
    fn contract_creation_requires_storage_payment() {
        use near_sdk::json_types::{U128, U64};
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::{testing_env, NearToken};
        let mut context = VMContextBuilder::new();
        context.predecessor_account_id(account("owner.testnet"));
        testing_env!(context.build());
        let mut arena = crate::Arena::new(
            account("owner.testnet"),
            account("usdc.testnet"),
            account("treasury.testnet"),
            U128(0),
            U64(60),
        );
        context.attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(context.build());
        arena.activate_lifecycle();
        arena.set_lifecycle_protocol(account("protocol.testnet"));
        context
            .predecessor_account_id(account("creator.testnet"))
            .attached_deposit(NearToken::from_yoctonear(0));
        testing_env!(context.build());
        arena.create_lifecycle_battle(
            vec![asset(1).into(), asset(2).into()],
            ScoringMode::PriceGain,
        );
    }

    #[test]
    fn stored_positions_remain_unchanged_after_lock() {
        use near_sdk::json_types::{U128, U64};
        let mut arena = crate::Arena::new(
            account("owner.testnet"),
            account("usdc.testnet"),
            account("treasury.testnet"),
            U128(0),
            U64(60),
        );
        let id = arena.lifecycle_insert(battle()).expect("insert");
        for i in 0..3 {
            arena
                .lifecycle_set_audit(id, i, Some(audit(i)))
                .expect("audit");
            arena
                .lifecycle_set_backing(id, i, Some(backing(i)))
                .expect("backing");
        }
        let creator = account("creator.testnet");
        let player = account("other.testnet");
        arena
            .lifecycle_register_position(id, 0, &creator)
            .expect("registration");
        arena
            .lifecycle_register_position(id, 1, &player)
            .expect("registration");
        arena
            .lifecycle_register_position(id, 2, &player)
            .expect("registration");
        arena
            .lifecycle_credit(id, 0, &asset(1).representation, &creator, 7)
            .expect("credit");
        arena
            .lifecycle_credit(id, 0, &asset(1).representation, &creator, 2)
            .expect("credit");
        arena
            .lifecycle_credit(id, 1, &asset(2).representation, &player, 11)
            .expect("credit");
        arena
            .lifecycle_credit(id, 2, &asset(3).representation, &player, 13)
            .expect("credit");
        assert_eq!(arena.lifecycle_position(id, 0, &creator), 9);
        let frozen = arena.lifecycle_lock(id, policy("p")).expect("lock");
        assert_eq!(frozen.communities[0].vault, 9);
        assert_eq!(
            arena.lifecycle_credit(id, 0, &asset(1).representation, &creator, 5),
            Err(LifecycleError::Locked)
        );
        assert_eq!(
            arena.lifecycle_set_audit(id, 0, None),
            Err(LifecycleError::Locked)
        );
        assert_eq!(arena.lifecycle_position(id, 0, &creator), 9);
        assert_eq!(arena.lifecycle_lock(id, policy("different")), Ok(frozen));
    }

    #[test]
    fn approval_is_required_and_protocol_must_deposit() {
        let mut protocol_fee = fee();
        protocol_fee.creator = protocol_fee.protocol.clone();
        protocol_fee.protocol_created = true;
        let mut b = Battle::new(
            vec![asset(1), asset(2)],
            ScoringMode::PriceGain,
            protocol_fee,
        )
        .expect("battle");
        assert_eq!(
            deposit(&mut b, 0, "protocol.testnet", 0, 1),
            Err(LifecycleError::MissingApproval)
        );
        for i in 0..2 {
            b.set_audit(i, Some(audit(i))).expect("audit");
            b.set_backing(i, Some(backing(i))).expect("backing");
        }
        deposit(&mut b, 0, "creator.testnet", 0, 1).expect("credit");
        deposit(&mut b, 1, "other.testnet", 0, 1).expect("credit");
        assert_eq!(
            b.lock(policy("p"), &ck()),
            Err(LifecycleError::CreatorHasNoPosition)
        );
        deposit(&mut b, 0, "protocol.testnet", 0, 1).expect("credit");
        assert!(b.lock(policy("p"), &ck()).is_ok());
    }
    fn audit_arena() -> (crate::Arena, u64) {
        use near_sdk::json_types::{U128, U64};
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::{testing_env, NearToken};
        let mut context = VMContextBuilder::new();
        context.predecessor_account_id(account("owner.testnet"));
        testing_env!(context.build());
        let mut arena = crate::Arena::new(
            account("owner.testnet"),
            account("usdc.testnet"),
            account("treasury.testnet"),
            U128(0),
            U64(60),
        );
        arena.add_agent(account("auditor.testnet"));
        context.attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(context.build());
        arena.activate_lifecycle();
        let id = arena.lifecycle_insert(battle()).expect("battle");
        context
            .predecessor_account_id(account("auditor.testnet"))
            .attached_deposit(NearToken::from_near(1));
        testing_env!(context.build());
        (arena, id)
    }

    #[test]
    fn auditor_pass_binds_asset_and_reject_withdraws_it() {
        let (mut arena, id) = audit_arena();
        arena.submit_lifecycle_audit(
            id,
            0,
            asset(1).into(),
            AuditResult::Pass,
            "goplus-v1".into(),
            "ev1".into(),
            Some(U64(60_000)),
        );
        let view = arena.get_lifecycle_battle(id).expect("view");
        assert_eq!(
            view.communities[0].audit_evidence_hash.as_deref(),
            Some("ev1")
        );
        assert_eq!(
            view.communities[0].audit_policy_hash.as_deref(),
            Some("goplus-v1")
        );
        arena.submit_lifecycle_audit(
            id,
            0,
            asset(1).into(),
            AuditResult::Pending,
            "goplus-v1".into(),
            "ev2".into(),
            None,
        );
        let view = arena.get_lifecycle_battle(id).expect("view");
        assert!(view.communities[0].audit_evidence_hash.is_none());
    }

    #[test]
    #[should_panic(expected = "Audit result cannot be recorded")]
    fn pass_for_another_asset_is_refused() {
        let (mut arena, id) = audit_arena();
        arena.submit_lifecycle_audit(
            id,
            0,
            asset(2).into(),
            AuditResult::Pass,
            "goplus-v1".into(),
            "ev1".into(),
            Some(U64(60_000)),
        );
    }

    #[test]
    #[should_panic(expected = "Audit asset does not match the community")]
    fn reject_for_another_asset_is_refused() {
        let (mut arena, id) = audit_arena();
        arena.submit_lifecycle_audit(
            id,
            0,
            asset(2).into(),
            AuditResult::Reject,
            "goplus-v1".into(),
            "ev1".into(),
            None,
        );
    }

    #[test]
    #[should_panic(expected = "Only a whitelisted agent")]
    fn only_a_whitelisted_agent_can_submit_audit() {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::testing_env;
        let (mut arena, id) = audit_arena();
        let mut context = VMContextBuilder::new();
        context.predecessor_account_id(account("stranger.testnet"));
        testing_env!(context.build());
        arena.submit_lifecycle_audit(
            id,
            0,
            asset(1).into(),
            AuditResult::Pass,
            "goplus-v1".into(),
            "ev1".into(),
            Some(U64(60_000)),
        );
    }

    #[test]
    fn lifecycle_battle_count_follows_insertions() {
        let (mut arena, _id) = audit_arena();
        assert_eq!(arena.get_lifecycle_battle_count(), 1);
        arena.lifecycle_insert(battle()).expect("battle");
        assert_eq!(arena.get_lifecycle_battle_count(), 2);
    }

    #[test]
    #[should_panic(expected = "at least 1 yoctoNEAR")]
    fn audit_submission_requires_a_deposit() {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::testing_env;
        let (mut arena, id) = audit_arena();
        let mut context = VMContextBuilder::new();
        context.predecessor_account_id(account("auditor.testnet"));
        testing_env!(context.build());
        arena.submit_lifecycle_audit(
            id,
            0,
            asset(1).into(),
            AuditResult::Pass,
            "goplus-v1".into(),
            "ev1".into(),
            Some(U64(60_000)),
        );
    }

    #[test]
    #[should_panic(expected = "Audit references are too long")]
    fn audit_references_are_bounded() {
        let (mut arena, id) = audit_arena();
        arena.submit_lifecycle_audit(
            id,
            0,
            asset(1).into(),
            AuditResult::Reject,
            "goplus-v1".into(),
            "e".repeat(257),
            None,
        );
    }

    #[test]
    #[should_panic(expected = "Audit result cannot be recorded")]
    fn audit_cannot_change_after_lock() {
        let (mut arena, id) = audit_arena();
        let mut b = arena.lifecycle_battles.get(&id).cloned().expect("battle");
        b.snapshot = Some(Snapshot {
            communities: b.communities.clone(),
            mode: ScoringMode::PriceGain,
            fee: fee(),
            observation: policy("p"),
            creator_participated: true,
        });
        arena.lifecycle_battles.insert(id, b);
        arena.submit_lifecycle_audit(
            id,
            0,
            asset(1).into(),
            AuditResult::Pass,
            "goplus-v1".into(),
            "ev1".into(),
            Some(U64(60_000)),
        );
    }
    fn with_reference(mut a: AssetIdentity, chain: u64, address: &str) -> AssetIdentity {
        a.reference_chain_id = Some(chain);
        a.reference_address = Some(address.into());
        a
    }
    const REF_A: &str = "0x00000000000000000000000000000000000000AA";
    const REF_B: &str = "0x00000000000000000000000000000000000000bb";

    fn new_battle(assets: Vec<AssetIdentity>) -> Result<Battle, LifecycleError> {
        Battle::new(assets, ScoringMode::PriceGain, fee())
    }

    #[test]
    fn reference_pair_is_optional_and_normalized_to_lowercase() {
        assert!(new_battle(vec![asset(1), asset(2)]).is_ok());
        let b = new_battle(vec![
            with_reference(asset(1), 4663, REF_A),
            with_reference(asset(2), 4663, REF_B),
        ])
        .expect("battle");
        let view = b.view();
        assert_eq!(view.communities[0].reference_chain_id, Some(U64(4663)));
        assert_eq!(
            view.communities[0].reference_address.as_deref(),
            Some(REF_A.to_ascii_lowercase().as_str())
        );
        // Mixed: one community with a pair, one without, is allowed.
        assert!(new_battle(vec![with_reference(asset(1), 4663, REF_A), asset(2)]).is_ok());
    }

    #[test]
    fn one_sided_or_malformed_reference_pair_is_rejected() {
        let mut only_chain = asset(1);
        only_chain.reference_chain_id = Some(4663);
        let mut only_addr = asset(1);
        only_addr.reference_address = Some(REF_A.into());
        for bad in [
            only_chain,
            only_addr,
            with_reference(asset(1), 4663, "0x1234"),
            with_reference(asset(1), 4663, "00000000000000000000000000000000000000aa"),
            with_reference(asset(1), 4663, "0xzz00000000000000000000000000000000000000"),
            with_reference(asset(1), 0, REF_A),
        ] {
            assert_eq!(
                new_battle(vec![bad, asset(2)]).err(),
                Some(LifecycleError::InvalidAsset)
            );
        }
    }

    #[test]
    fn duplicate_reference_pair_is_rejected_case_insensitively() {
        let lower = REF_A.to_ascii_lowercase();
        assert_eq!(
            new_battle(vec![
                with_reference(asset(1), 4663, REF_A),
                with_reference(asset(2), 4663, &lower),
            ])
            .err(),
            Some(LifecycleError::DuplicateAsset)
        );
        // Same address on a different reference chain is a different token.
        assert!(new_battle(vec![
            with_reference(asset(1), 4663, REF_A),
            with_reference(asset(2), 1, REF_A),
        ])
        .is_ok());
    }

    #[test]
    fn audit_must_equal_the_committed_reference_pair() {
        let mut b = new_battle(vec![
            with_reference(asset(1), 4663, REF_A),
            with_reference(asset(2), 4663, REF_B),
        ])
        .expect("battle");
        let committed = b.communities[0].asset.clone();
        let approval = |asset: AssetIdentity| AuditApproval {
            asset,
            policy_hash: "p".into(),
            evidence_hash: "e".into(),
            expires_at_ms: FAR,
        };
        assert_eq!(b.set_audit(0, Some(approval(committed.clone()))), Ok(()));
        // Missing pair, other address and other chain are all refused.
        let mut missing = committed.clone();
        missing.reference_chain_id = None;
        missing.reference_address = None;
        let other_addr = with_reference(asset(1), 4663, REF_B);
        let other_chain = with_reference(asset(1), 1, REF_A);
        for bad in [missing, other_addr, other_chain] {
            assert_eq!(
                b.set_audit(0, Some(approval(bad))),
                Err(LifecycleError::InvalidApproval)
            );
        }
    }

    #[test]
    fn arena_audit_submission_checks_the_reference_pair_and_input_json_is_backward_compatible() {
        use near_sdk::json_types::U64;
        let without: AssetInput = near_sdk::serde_json::from_value(near_sdk::serde_json::json!({
            "chain_id": "46630", "token_address": "0x0000000000000000000000000000000000000001",
            "representation": "token.testnet", "custody_domain": "vault"
        }))
        .expect("input without pair");
        assert!(without.reference_chain_id.is_none());
        let (mut arena, _) = audit_arena();
        let mut a = asset(5);
        a.reference_chain_id = Some(4663);
        a.reference_address = Some(REF_A.into());
        let mut b = asset(6);
        b.reference_chain_id = Some(4663);
        b.reference_address = Some(REF_B.into());
        let id = arena
            .lifecycle_insert(new_battle(vec![a.clone(), b]).expect("battle"))
            .expect("insert");
        // The committed pair is accepted whatever the case of the submitted address.
        let mut input: AssetInput = a.clone().into();
        input.reference_address = Some(REF_A.to_ascii_uppercase().replace("0X", "0x"));
        arena.submit_lifecycle_audit(
            id,
            0,
            input,
            AuditResult::Pass,
            "p".into(),
            "e".into(),
            Some(U64(60_000)),
        );
        assert!(arena.get_lifecycle_battle(id).expect("view").communities[0]
            .audit_evidence_hash
            .is_some());
        let view = arena.get_lifecycle_battle(id).expect("view");
        assert_eq!(view.communities[1].reference_chain_id, Some(U64(4663)));
    }

    #[test]
    #[should_panic(expected = "Audit result cannot be recorded")]
    fn arena_pass_with_a_different_reference_pair_is_refused() {
        let (mut arena, _) = audit_arena();
        let a = with_reference(asset(5), 4663, REF_A);
        let b = with_reference(asset(6), 4663, REF_B);
        let id = arena
            .lifecycle_insert(new_battle(vec![a.clone(), b]).expect("battle"))
            .expect("insert");
        let mut wrong: AssetInput = a.into();
        wrong.reference_address = Some(REF_B.into());
        arena.submit_lifecycle_audit(
            id,
            0,
            wrong,
            AuditResult::Pass,
            "p".into(),
            "e".into(),
            Some(U64(60_000)),
        );
    }

    #[test]
    #[should_panic(expected = "Audit asset does not match the community")]
    fn arena_reject_with_a_missing_reference_pair_is_refused() {
        let (mut arena, _) = audit_arena();
        let a = with_reference(asset(5), 4663, REF_A);
        let b = with_reference(asset(6), 4663, REF_B);
        let id = arena
            .lifecycle_insert(new_battle(vec![a.clone(), b]).expect("battle"))
            .expect("insert");
        let mut wrong: AssetInput = a.into();
        wrong.reference_chain_id = None;
        wrong.reference_address = None;
        arena.submit_lifecycle_audit(
            id,
            0,
            wrong,
            AuditResult::Reject,
            "p".into(),
            "e".into(),
            None,
        );
    }

    fn funded(b: &mut Battle) {
        approve(b);
        deposit(b, 0, "creator.testnet", 0, 7).expect("credit");
        deposit(b, 1, "other.testnet", 0, 11).expect("credit");
        deposit(b, 2, "other.testnet", 0, 13).expect("credit");
    }

    fn check_at(now_ms: u64) -> LockCheck {
        LockCheck {
            now_ms,
            required_policy_hash: None,
        }
    }

    #[test]
    fn lock_is_refused_at_or_after_expiry_and_allowed_before() {
        let mut b = battle();
        funded(&mut b);
        b.communities[1]
            .audit
            .as_mut()
            .expect("audit")
            .expires_at_ms = 1_000;
        assert_eq!(
            b.lock(policy("p"), &check_at(1_000)),
            Err(LifecycleError::ExpiredApproval)
        );
        assert_eq!(
            b.lock(policy("p"), &check_at(5_000)),
            Err(LifecycleError::ExpiredApproval)
        );
        assert!(!b.view().locked);
        assert!(b.lock(policy("p"), &check_at(999)).is_ok());
    }

    #[test]
    fn repeated_lock_after_expiry_returns_the_original_snapshot() {
        let mut b = battle();
        funded(&mut b);
        b.communities[0]
            .audit
            .as_mut()
            .expect("audit")
            .expires_at_ms = 1_000;
        let frozen = b.lock(policy("p"), &check_at(10)).expect("lock").clone();
        assert_eq!(b.lock(policy("p"), &check_at(99_999)), Ok(&frozen));
    }

    #[test]
    fn lock_is_refused_when_the_approval_no_longer_binds_the_community_asset() {
        let mut b = battle();
        funded(&mut b);
        b.communities[2].audit.as_mut().expect("audit").asset = asset(9);
        assert_eq!(
            b.lock(policy("p"), &ck()),
            Err(LifecycleError::ApprovalMismatch)
        );
    }

    #[test]
    fn lock_requires_the_pinned_policy_hash_when_configured() {
        let mut b = battle();
        funded(&mut b);
        let pinned = |hash: &str| LockCheck {
            now_ms: 0,
            required_policy_hash: Some(hash.into()),
        };
        assert_eq!(
            b.lock(policy("p"), &pinned("policy-v2")),
            Err(LifecycleError::ApprovalMismatch)
        );
        assert!(b.lock(policy("p"), &pinned("policy")).is_ok());
    }

    #[test]
    fn a_missing_approval_is_refused_before_any_expiry_logic() {
        let mut b = battle();
        funded(&mut b);
        b.set_audit(1, None).expect("withdraw");
        assert_eq!(
            b.lock(policy("p"), &ck()),
            Err(LifecycleError::MissingApproval)
        );
    }

    #[test]
    fn expired_backing_refuses_lock_and_a_refresh_allows_it() {
        let mut b = battle();
        funded(&mut b);
        b.communities[1]
            .backing
            .as_mut()
            .expect("backing")
            .expires_at_ms = 1_000;
        assert_eq!(
            b.lock(policy("p"), &check_at(1_000)),
            Err(LifecycleError::ExpiredApproval)
        );
        assert!(!b.view().locked);
        let mut fresh = backing(1);
        fresh.expires_at_ms = 5_000;
        b.set_backing(1, Some(fresh)).expect("refresh");
        assert!(b.lock(policy("p"), &check_at(1_000)).is_ok());
    }

    #[test]
    fn backing_for_another_asset_is_refused_at_storage_and_at_lock() {
        let mut b = battle();
        let mut wrong = backing(0);
        wrong.asset = asset(9);
        assert_eq!(
            b.set_backing(0, Some(wrong)),
            Err(LifecycleError::InvalidApproval)
        );
        funded(&mut b);
        b.communities[0].backing.as_mut().expect("backing").asset = asset(9);
        assert_eq!(
            b.lock(policy("p"), &ck()),
            Err(LifecycleError::ApprovalMismatch)
        );
        let mut zero = backing(0);
        zero.expires_at_ms = 0;
        assert_eq!(
            b.set_backing(0, Some(zero)),
            Err(LifecycleError::InvalidApproval)
        );
    }

    #[test]
    fn deposits_need_backing_for_every_community_and_the_right_representation() {
        let mut b = battle();
        for i in 0..3 {
            b.set_audit(i, Some(audit(i))).expect("audit");
        }
        // No backing yet: nothing is credited.
        assert_eq!(
            deposit(&mut b, 0, "creator.testnet", 0, 5),
            Err(LifecycleError::MissingApproval)
        );
        for i in 0..2 {
            b.set_backing(i, Some(backing(i))).expect("backing");
        }
        assert_eq!(
            deposit(&mut b, 0, "creator.testnet", 0, 5),
            Err(LifecycleError::MissingApproval)
        );
        b.set_backing(2, Some(backing(2))).expect("backing");
        // A transfer from another token is not a backed deposit of this community.
        assert_eq!(
            b.credit(
                0,
                &asset(2).representation,
                &account("creator.testnet"),
                0,
                5
            ),
            Err(LifecycleError::WrongRepresentation)
        );
        assert_eq!(deposit(&mut b, 0, "creator.testnet", 0, 5), Ok(5));
        // Only a creator deposit counts as creator participation.
        deposit(&mut b, 1, "other.testnet", 0, 5).expect("credit");
        deposit(&mut b, 2, "other.testnet", 0, 5).expect("credit");
        assert!(b.lock(policy("p"), &ck()).is_ok());
    }

    #[test]
    fn a_protocol_created_battle_also_needs_a_protocol_position_and_every_vault() {
        let protocol = account("protocol.testnet");
        let fee = FeePolicy {
            creator: protocol.clone(),
            protocol_created: true,
            ..fee()
        };
        let mut b = Battle::new(
            vec![asset(1), asset(2), asset(3)],
            ScoringMode::PriceGain,
            fee,
        )
        .expect("battle");
        approve(&mut b);
        deposit(&mut b, 1, "other.testnet", 0, 5).expect("credit");
        deposit(&mut b, 2, "other.testnet", 0, 5).expect("credit");
        assert_eq!(b.lock(policy("p"), &ck()), Err(LifecycleError::EmptyVault));
        // A protocol deposit alone is not enough without every other vault, and a
        // third party's deposit never counts as the protocol's position.
        deposit(&mut b, 0, "other.testnet", 0, 5).expect("credit");
        assert_eq!(
            b.lock(policy("p"), &ck()),
            Err(LifecycleError::CreatorHasNoPosition)
        );
        deposit(&mut b, 0, "protocol.testnet", 0, 5).expect("credit");
        assert!(b.lock(policy("p"), &ck()).is_ok());
    }

    #[test]
    fn approval_with_zero_expiry_is_refused_at_storage() {
        let mut b = battle();
        let mut zero = audit(0);
        zero.expires_at_ms = 0;
        assert_eq!(
            b.set_audit(0, Some(zero)),
            Err(LifecycleError::InvalidApproval)
        );
    }

    fn arena_at(now_ms: u64) {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::{testing_env, NearToken};
        let mut context = VMContextBuilder::new();
        context
            .predecessor_account_id(account("auditor.testnet"))
            .attached_deposit(NearToken::from_near(1))
            .block_timestamp(now_ms * 1_000_000);
        testing_env!(context.build());
    }

    #[test]
    fn arena_pass_stores_the_expiry_from_the_submission_and_exposes_it() {
        let (mut arena, id) = audit_arena();
        arena_at(10_000);
        arena.submit_lifecycle_audit(
            id,
            0,
            asset(1).into(),
            AuditResult::Pass,
            "p".into(),
            "e".into(),
            Some(U64(70_000)),
        );
        let view = arena.get_lifecycle_battle(id).expect("view");
        assert_eq!(view.communities[0].audit_expires_at_ms, Some(U64(70_000)));
    }

    #[test]
    #[should_panic(expected = "Approval is already expired")]
    fn arena_pass_with_an_expiry_not_in_the_future_is_refused() {
        let (mut arena, id) = audit_arena();
        arena_at(10_000);
        arena.submit_lifecycle_audit(
            id,
            0,
            asset(1).into(),
            AuditResult::Pass,
            "p".into(),
            "e".into(),
            Some(U64(10_000)),
        );
    }

    #[test]
    #[should_panic(expected = "Approval expiry is too far ahead")]
    fn arena_pass_with_an_expiry_beyond_the_maximum_is_refused() {
        let (mut arena, id) = audit_arena();
        arena_at(10_000);
        arena.submit_lifecycle_audit(
            id,
            0,
            asset(1).into(),
            AuditResult::Pass,
            "p".into(),
            "e".into(),
            Some(U64(10_000 + MAX_AUDIT_APPROVAL_MS + 1)),
        );
    }

    #[test]
    #[should_panic(expected = "A pass requires expires_at_ms")]
    fn arena_pass_without_an_expiry_is_refused() {
        let (mut arena, id) = audit_arena();
        arena_at(10_000);
        arena.submit_lifecycle_audit(
            id,
            0,
            asset(1).into(),
            AuditResult::Pass,
            "p".into(),
            "e".into(),
            None,
        );
    }
}
