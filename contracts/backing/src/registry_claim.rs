//! Validation of registry responses; this does not authenticate a response,
//! verify source-chain state or enable a mint entry point.
use crate::Asset;
use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

/// JSON shape of the shared registry's immutable claim.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryClaim {
    pub representation: AccountId,
    pub token_address: String,
    pub custody_domain: String,
    pub mapping_version: U64,
    pub beneficiary: AccountId,
    pub battle_id: U64,
    pub actual_received: U128,
    pub block_number: U64,
    pub block_hash: [u8; 32],
    pub finalized_head_number: U64,
    pub finalized_head_hash: [u8; 32],
    pub evidence_hash: [u8; 32],
}

/// Caller must additionally authenticate the configured registry and the exact
/// requested receipt key, validate status at use time, charge storage and
/// handle asynchronous callbacks and disputes before invoking any mutation.
pub fn matches_asset(
    claim: &RegistryClaim,
    asset: &Asset,
    representation: &AccountId,
    mapping_version: u64,
) -> bool {
    claim.representation == *representation
        && claim
            .token_address
            .eq_ignore_ascii_case(&asset.token_address)
        && claim.custody_domain == asset.custody_domain
        && claim.mapping_version.0 == mapping_version
        && claim.actual_received.0 > 0
        && claim.block_number.0 <= claim.finalized_head_number.0
        && claim.block_hash != [0; 32]
        && claim.finalized_head_hash != [0; 32]
        && claim.evidence_hash != [0; 32]
        && (claim.block_number.0 != claim.finalized_head_number.0
            || claim.block_hash == claim.finalized_head_hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn account(value: &str) -> AccountId {
        value.parse().unwrap()
    }
    fn asset() -> Asset {
        Asset {
            chain_id: U64(46630),
            token_address: "0x00000000000000000000000000000000000000ab".into(),
            custody_domain: "custody".into(),
            source_decimals: 18,
            representation_decimals: 18,
        }
    }
    fn claim() -> RegistryClaim {
        RegistryClaim {
            representation: account("token.testnet"),
            token_address: "0x00000000000000000000000000000000000000AB".into(),
            custody_domain: "custody".into(),
            mapping_version: U64(1),
            beneficiary: account("alice.testnet"),
            battle_id: U64(1),
            actual_received: U128(98),
            block_number: U64(3),
            block_hash: [1; 32],
            finalized_head_number: U64(4),
            finalized_head_hash: [2; 32],
            evidence_hash: [3; 32],
        }
    }
    #[test]
    fn rejects_mapping_and_evidence_mismatches() {
        let valid = claim();
        assert!(matches_asset(
            &valid,
            &asset(),
            &account("token.testnet"),
            1
        ));
        assert!(!matches_asset(
            &valid,
            &asset(),
            &account("other.testnet"),
            1
        ));
        assert!(!matches_asset(
            &valid,
            &asset(),
            &account("token.testnet"),
            2
        ));
        let mut wrong = valid.clone();
        wrong.custody_domain = "other".into();
        assert!(!matches_asset(
            &wrong,
            &asset(),
            &account("token.testnet"),
            1
        ));
        wrong = valid.clone();
        wrong.evidence_hash = [0; 32];
        assert!(!matches_asset(
            &wrong,
            &asset(),
            &account("token.testnet"),
            1
        ));
        wrong = valid;
        wrong.block_number = U64(5);
        assert!(!matches_asset(
            &wrong,
            &asset(),
            &account("token.testnet"),
            1
        ));
    }
}
