use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::serde_json::Value;

/// Identity of the Robinhood asset this representation backs. Every token
/// identity binds chain id, token contract address, representation decimals
/// and the custody domain; never symbol alone.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetIdentity {
    pub chain_id: u64,
    pub token_address: String,
    /// Decimals of the NEP-141 representation.
    pub decimals: u8,
    /// Custody address/domain where verified Robinhood receipts arrive.
    pub custody_domain: String,
    pub symbol: String,
    pub name: String,
}

/// Unique identity of a finalized source receipt:
/// `(chain_id, tx_hash, log_index)`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ReceiptId {
    pub chain_id: u64,
    pub tx_hash: String,
    pub log_index: u32,
}

/// What a reservation is for; governs restoration on definitive failure.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoutKind {
    /// Winning reward or revenue entitlement paid to a beneficiary.
    Reward,
    /// Representation redemption returning source tokens to the holder.
    Redemption,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoutStatus {
    Reserved,
    Broadcast,
    Confirmed,
    Failed,
}

/// A pending payout reservation (`P`). Confirmed payouts are retained for
/// replay protection.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payout {
    pub id: u64,
    pub battle_id: u64,
    pub beneficiary: near_sdk::AccountId,
    pub amount: near_sdk::json_types::U128,
    pub kind: PayoutKind,
    /// Stable nonce bound to this payout identity; replacements reuse it.
    pub nonce: u64,
    pub status: PayoutStatus,
    pub tx_hash: Option<String>,
    pub confirmed: Option<Evidence>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisposalKind {
    Burn,
    Return,
}

/// A reserved DAO-directed disposal (`D`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Disposal {
    pub id: u64,
    pub battle_id: u64,
    pub amount: near_sdk::json_types::U128,
    pub kind: DisposalKind,
    pub confirmed: Option<Evidence>,
}

/// Final matching execution evidence. A signature or broadcast alone never
/// counts as confirmation.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Evidence {
    pub success: bool,
    /// Whether the evidence proves an actual chain movement happened.
    pub executed_movement: bool,
    pub chain_id: u64,
    pub tx_hash: String,
    pub finality: String,
}

/// Public ledger snapshot: `B = M + E + P + D + U`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LedgerView {
    /// B: verified custody in representation units.
    pub custody: U128,
    /// M: live representation supply.
    pub supply: U128,
    /// E: allocated entitlements.
    pub entitlements: U128,
    /// P: pending payout/redemption reservations.
    pub payouts_reserved: U128,
    /// D: pending disposal reservations.
    pub disposals_reserved: U128,
    /// U: verified unallocated attributed custody.
    pub unallocated: U128,
    /// Unrepresentable residue; attributed, never minted, not part of B/M/E/P/D/U.
    pub residual: U128,
    pub invariant_holds: bool,
}

/// JSON mirror of `Payout` for API views.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PayoutView {
    pub id: u64,
    pub battle_id: u64,
    pub beneficiary: near_sdk::AccountId,
    pub amount: near_sdk::json_types::U128,
    pub kind: PayoutKind,
    pub nonce: u64,
    pub status: PayoutStatus,
    pub tx_hash: Option<String>,
    pub confirmed: Option<Evidence>,
}

pub fn evidence_to_json(evidence: &Evidence) -> Value {
    Value::String(format!(
        "{}:{}:{}/{}",
        evidence.chain_id, evidence.tx_hash, evidence.finality, evidence.success
    ))
}
