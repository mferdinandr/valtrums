//! Suspension state, resume policy and custody-balance attestations.
//!
//! A suspension blocks minting, new reservations and payouts for the asset. It
//! never changes a liability bucket. The attestation is a trusted-operator
//! statement about the custody balance at a source block; it is not a proof.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::Value;
use near_sdk::{env, near};

/// How a suspension caused by a reorg or a custody deficit can be lifted.
/// The owner can change the policy at any time (hackathon decision), so
/// `Disabled` means "no resume while this policy is selected".
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResumePolicy {
    /// Only the owner may resume, and only while a later attestation shows the
    /// custody balance covers every liability.
    #[default]
    OwnerWithEvidence,
    /// A later attestation that covers every liability lifts the suspension.
    /// This trades safety for speed: no human reviews the evidence.
    Automatic,
    /// No resume path while selected.
    Disabled,
}

/// Why the asset is suspended. Unresolved reconciliation is tracked per
/// reservation and is cleared only by a confirmation or a release.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Suspension {
    pub reorg: bool,
    pub deficit: bool,
    pub unresolved: u64,
    /// Attestation sequence when the latest reason was set. A resume needs an
    /// attestation with a higher sequence.
    pub since_attestation: u64,
}

impl Suspension {
    /// Reorg or deficit; these are the reasons a covering attestation can lift.
    pub fn evidence_liftable(&self) -> bool {
        self.reorg || self.deficit
    }
    pub fn any(&self) -> bool {
        self.reorg || self.deficit || self.unresolved > 0
    }
}

/// Operator statement of the custody balance at a finalized source block.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CustodyAttestation {
    pub sequence: U64,
    pub source_block_number: U64,
    pub source_block_hash: [u8; 32],
    pub finalized_head_number: U64,
    pub finalized_head_hash: [u8; 32],
    pub balance: U128,
    pub evidence_hash: [u8; 32],
    /// Liabilities in source units when the attestation was evaluated.
    pub required: U128,
    pub covered: bool,
}

#[near(serializers = [json])]
pub struct SuspensionView {
    pub suspended: bool,
    pub reorg: bool,
    pub deficit: bool,
    pub unresolved: U64,
    pub since_attestation: U64,
    pub resume_policy: ResumePolicy,
    pub operator: Option<near_sdk::AccountId>,
    pub last_attestation: Option<CustodyAttestation>,
}

/// NEP-297 style event line.
pub fn emit(event: &str, data: Value) {
    let line = near_sdk::serde_json::json!({
        "standard": "valtrum_backing",
        "version": "1.0.0",
        "event": event,
        "data": data,
    });
    env::log_str(&format!("EVENT_JSON:{line}"));
}
