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

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetIdentity {
    pub chain_id: u64,
    pub token_address: String,
    pub representation: AccountId,
    pub custody_domain: String,
}

/// JSON-facing identity keeps 64-bit chain IDs exact in JavaScript clients.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetInput {
    pub chain_id: U64,
    pub token_address: String,
    pub representation: AccountId,
    pub custody_domain: String,
}

impl From<AssetInput> for AssetIdentity {
    fn from(value: AssetInput) -> Self {
        Self {
            chain_id: value.chain_id.0,
            token_address: value.token_address,
            representation: value.representation,
            custody_domain: value.custody_domain,
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

/// References supplied independently by the audit and backing adapters.
/// An evidence reference is not itself proof of validity or authorization.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditApproval {
    pub asset: AssetIdentity,
    pub policy_hash: String,
    pub evidence_hash: String,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackingApproval {
    pub asset: AssetIdentity,
    pub evidence_hash: String,
}

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
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommunityView {
    pub chain_id: U64,
    pub token_address: String,
    pub representation: AccountId,
    pub custody_domain: String,
    pub vault: U128,
    pub audit_policy_hash: Option<String>,
    pub audit_evidence_hash: Option<String>,
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
    EmptyVault,
    CreatorHasNoPosition,
    NotLocked,
    ConflictingWinner,
    PositionNotRegistered,
    PositionAlreadyRegistered,
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
            // Chain IDs identify EVM chains; their hex addresses are case-insensitive.
            if !original_assets.insert((asset.chain_id, asset.token_address.to_ascii_lowercase()))
                || !representations.insert(asset.representation.clone())
            {
                return Err(LifecycleError::DuplicateAsset);
            }
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
                    vault: U128(community.vault),
                    audit_policy_hash: community.audit.as_ref().map(|e| e.policy_hash.clone()),
                    audit_evidence_hash: community.audit.as_ref().map(|e| e.evidence_hash.clone()),
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

    /// The adapter must revalidate approval and backing before lock. Once
    /// frozen, duplicate lock calls return the original snapshot unchanged.
    pub fn lock(&mut self, observation: ObservationPolicy) -> Result<&Snapshot, LifecycleError> {
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
        self.lifecycle_positions.insert(key, next);
        self.lifecycle_battles.insert(id, battle);
        Ok(())
    }

    pub fn lifecycle_lock(
        &mut self,
        id: u64,
        policy: ObservationPolicy,
    ) -> Result<Snapshot, LifecycleError> {
        let mut battle = self
            .lifecycle_battles
            .get(&id)
            .cloned()
            .ok_or(LifecycleError::UnknownBattle)?;
        let snapshot = battle.lock(policy)?.clone();
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
        Ok(hold)
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
        }
    }
    fn backing(index: usize) -> BackingApproval {
        BackingApproval {
            asset: asset(index as u8 + 1),
            evidence_hash: format!("backing-{index}"),
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
        let frozen = b.lock(policy("original")).expect("lock").clone();
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
        assert_eq!(b.lock(policy("changed")), Ok(&frozen));
    }

    #[test]
    fn withdrawn_evidence_holds_lock_and_does_not_change_vaults() {
        let mut b = battle();
        approve(&mut b);
        deposit(&mut b, 0, "creator.testnet", 0, 7).expect("credit");
        deposit(&mut b, 1, "other.testnet", 0, 11).expect("credit");
        deposit(&mut b, 2, "other.testnet", 0, 13).expect("credit");
        b.set_backing(1, None).expect("withdraw evidence");
        assert_eq!(b.lock(policy("p")), Err(LifecycleError::MissingApproval));
        assert_eq!(b.communities[1].vault, 11);
        assert_eq!(
            deposit(&mut b, 0, "creator.testnet", 7, 1),
            Err(LifecycleError::MissingApproval)
        );
        b.set_backing(1, Some(backing(1)))
            .expect("restore evidence");
        assert_eq!(b.lock(policy("p")).expect("lock").communities[1].vault, 11);
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
            b.lock(policy("p")),
            Err(LifecycleError::CreatorHasNoPosition)
        );
        let mut b = battle();
        approve(&mut b);
        deposit(&mut b, 0, "creator.testnet", 0, 1).expect("credit");
        assert_eq!(b.lock(policy("p")), Err(LifecycleError::EmptyVault));
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
    fn principal_hold_requires_lock_and_cannot_change_winner() {
        let mut b = battle();
        assert_eq!(b.hold_principal(0), Err(LifecycleError::NotLocked));
        approve(&mut b);
        deposit(&mut b, 0, "creator.testnet", 0, 7).expect("credit");
        deposit(&mut b, 1, "other.testnet", 0, 11).expect("credit");
        deposit(&mut b, 2, "other.testnet", 0, 13).expect("credit");
        b.lock(policy("p")).expect("lock");
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
            b.lock(policy("p")),
            Err(LifecycleError::CreatorHasNoPosition)
        );
        deposit(&mut b, 0, "protocol.testnet", 0, 1).expect("credit");
        assert!(b.lock(policy("p")).is_ok());
    }
}
