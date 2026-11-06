//! Receipt identity and state; authority and finality verification are external.
use near_sdk::{near, AccountId};

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ReceiptId {
    pub chain_id: u64,
    pub transaction_hash: [u8; 32],
    pub log_index: u32,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReceiptStatus {
    Provisional,
    Finalized,
    Reorganized,
    /// A previously finalized receipt is disputed; liabilities are retained.
    Disputed,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub id: ReceiptId,
    pub beneficiary: AccountId,
    pub actual_source_amount: u128,
    pub source_block_hash: [u8; 32],
    pub status: ReceiptStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReceiptError {
    InvalidHash,
    InvalidTransition,
}

impl ReceiptId {
    /// Parse the binary transaction hash, making hex casing irrelevant to replay.
    pub fn from_hex(chain_id: u64, hash: &str, log_index: u32) -> Result<Self, ReceiptError> {
        let hex = hash
            .strip_prefix("0x")
            .or_else(|| hash.strip_prefix("0X"))
            .ok_or(ReceiptError::InvalidHash)?;
        if hex.len() != 64 {
            return Err(ReceiptError::InvalidHash);
        }
        let mut bytes = [0_u8; 32];
        for (output, pair) in bytes.iter_mut().zip(hex.as_bytes().chunks_exact(2)) {
            let high = (pair[0] as char)
                .to_digit(16)
                .ok_or(ReceiptError::InvalidHash)?;
            let low = (pair[1] as char)
                .to_digit(16)
                .ok_or(ReceiptError::InvalidHash)?;
            *output = ((high << 4) | low) as u8;
        }
        Ok(Self {
            chain_id,
            transaction_hash: bytes,
            log_index,
        })
    }
}

impl Receipt {
    /// Returns true only for the first finalization, when liabilities may be credited.
    /// The caller must first verify finalized evidence bound to this exact receipt.
    pub fn finalize(&mut self) -> Result<bool, ReceiptError> {
        match self.status {
            ReceiptStatus::Provisional => {
                self.status = ReceiptStatus::Finalized;
                Ok(true)
            }
            ReceiptStatus::Finalized => Ok(false),
            ReceiptStatus::Reorganized | ReceiptStatus::Disputed => {
                Err(ReceiptError::InvalidTransition)
            }
        }
    }

    /// Reorganization after finality is a dispute, not an automatic reversal.
    pub fn mark_reorganized(&mut self) {
        self.status = match self.status {
            ReceiptStatus::Provisional | ReceiptStatus::Reorganized => ReceiptStatus::Reorganized,
            ReceiptStatus::Finalized | ReceiptStatus::Disputed => ReceiptStatus::Disputed,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn receipt() -> Receipt {
        Receipt {
            id: ReceiptId::from_hex(46630, &format!("0x{}", "ab".repeat(32)), 1).expect("hash"),
            beneficiary: "alice.testnet".parse().expect("account"),
            actual_source_amount: 98,
            source_block_hash: [7; 32],
            status: ReceiptStatus::Provisional,
        }
    }
    #[test]
    fn hashes_are_binary_and_replay_identity_is_case_insensitive() {
        let lower =
            ReceiptId::from_hex(46630, &format!("0x{}", "ab".repeat(32)), 1).expect("lower");
        let upper =
            ReceiptId::from_hex(46630, &format!("0X{}", "AB".repeat(32)), 1).expect("upper");
        assert_eq!(lower, upper);
        assert_eq!(
            ReceiptId::from_hex(46630, "0x1", 1),
            Err(ReceiptError::InvalidHash)
        );
        assert_eq!(
            ReceiptId::from_hex(46630, &format!("0x{}", "zz".repeat(32)), 1),
            Err(ReceiptError::InvalidHash)
        );
    }
    #[test]
    fn replay_does_not_finalize_twice_and_reorgs_fail_closed() {
        let mut finalized = receipt();
        assert_eq!(finalized.finalize(), Ok(true));
        assert_eq!(finalized.finalize(), Ok(false));
        finalized.mark_reorganized();
        assert_eq!(finalized.status, ReceiptStatus::Disputed);
        assert_eq!(finalized.finalize(), Err(ReceiptError::InvalidTransition));
        let mut provisional = receipt();
        provisional.mark_reorganized();
        assert_eq!(provisional.finalize(), Err(ReceiptError::InvalidTransition));
    }
}
