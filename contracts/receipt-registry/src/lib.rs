//! Testnet receipt registry. Operator attestations are trusted assertions,
//! not cryptographic proof of source-chain finality or custody.
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise,
};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Claims,
    Representations,
    Disputes,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ReceiptKey {
    pub chain_id: U64,
    pub transaction_hash: [u8; 32],
    pub log_index: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub representation: AccountId,
    pub token_address: String,
    pub custody_domain: String,
    pub mapping_version: U64,
    pub beneficiary: AccountId,
    /// EVM address bound at deposit time that a late deposit is returned to (D17).
    pub refund_address: [u8; 20],
    pub battle_id: U64,
    pub actual_received: U128,
    pub block_number: U64,
    pub block_hash: [u8; 32],
    pub finalized_head_number: U64,
    pub finalized_head_hash: [u8; 32],
    pub evidence_hash: [u8; 32],
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ReceiptRegistry {
    owner: AccountId,
    verifier: AccountId,
    claims: LookupMap<ReceiptKey, Claim>,
    representations: LookupMap<AccountId, bool>,
    disputes: LookupMap<ReceiptKey, bool>,
}

#[near]
impl ReceiptRegistry {
    #[init]
    pub fn new(owner: AccountId, verifier: AccountId) -> Self {
        Self {
            owner,
            verifier,
            claims: LookupMap::new(StorageKey::Claims),
            representations: LookupMap::new(StorageKey::Representations),
            disputes: LookupMap::new(StorageKey::Disputes),
        }
    }

    /// The owner authorizes representation contracts, but cannot remove or
    /// overwrite any existing receipt claim.
    #[payable]
    pub fn set_representation(&mut self, representation: AccountId, allowed: bool) {
        require!(env::predecessor_account_id() == self.owner, "Only owner");
        let before = env::storage_usage();
        self.representations.insert(representation, allowed);
        self.representations.flush();
        let bytes = env::storage_usage().saturating_sub(before);
        let cost = env::storage_byte_cost()
            .as_yoctonear()
            .checked_mul(u128::from(bytes))
            .expect("Storage cost overflow");
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, "Insufficient storage deposit");
        if attached > cost {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(attached - cost))
                .detach();
        }
    }

    #[payable]
    pub fn set_verifier(&mut self, verifier: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "Only owner");
        near_sdk::assert_one_yocto();
        self.verifier = verifier;
    }

    /// Permanently bind a global receipt key to one claim. No deletion or
    /// replacement path exists, even when a later cross-contract call fails.
    #[payable]
    pub fn attest(&mut self, key: ReceiptKey, claim: Claim) -> bool {
        let mut claim = claim;
        require!(
            env::predecessor_account_id() == self.verifier,
            "Only verifier"
        );
        require!(
            self.representations.get(&claim.representation) == Some(&true),
            "Representation not authorized"
        );
        require!(
            key.chain_id.0 == 46630 && key.transaction_hash != [0; 32],
            "Invalid source identity"
        );
        let address = claim.token_address.strip_prefix("0x");
        require!(
            address.is_some_and(|s| s.len() == 40
                && s.bytes().all(|b| b.is_ascii_hexdigit())
                && s.bytes().any(|b| b != b'0')),
            "Invalid token"
        );
        claim.token_address = claim.token_address.to_ascii_lowercase();
        require!(
            !claim.custody_domain.trim().is_empty() && claim.custody_domain.len() <= 256,
            "Invalid custody domain"
        );
        require!(claim.refund_address != [0; 20], "Missing refund address");
        require!(
            claim.actual_received.0 > 0
                && claim.block_hash != [0; 32]
                && claim.finalized_head_hash != [0; 32]
                && claim.evidence_hash != [0; 32],
            "Incomplete evidence"
        );
        require!(
            claim.block_number.0 <= claim.finalized_head_number.0,
            "Receipt after finalized head"
        );
        require!(
            claim.block_number.0 != claim.finalized_head_number.0
                || claim.block_hash == claim.finalized_head_hash,
            "Inconsistent finalized block"
        );
        require!(
            self.disputes.get(&key) != Some(&true),
            "Receipt is disputed"
        );
        if let Some(existing) = self.claims.get(&key) {
            require!(existing == &claim, "Conflicting receipt claim");
            let deposit = env::attached_deposit();
            if !deposit.is_zero() {
                Promise::new(env::predecessor_account_id())
                    .transfer(deposit)
                    .detach();
            }
            return false;
        }
        let before = env::storage_usage();
        self.claims.insert(key, claim);
        self.claims.flush();
        let bytes = env::storage_usage()
            .checked_sub(before)
            .expect("Storage accounting failed");
        let cost = env::storage_byte_cost()
            .as_yoctonear()
            .checked_mul(u128::from(bytes))
            .expect("Storage cost overflow");
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, "Insufficient storage deposit");
        if attached > cost {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(attached - cost))
                .detach();
        }
        true
    }

    pub fn get_claim(&self, key: ReceiptKey) -> Option<Claim> {
        self.claims.get(&key).cloned()
    }

    /// A dispute never releases a key or reverses a liability. Recovery needs a
    /// separately reviewed reconciliation process; no clearing path is exposed.
    #[payable]
    pub fn dispute(&mut self, key: ReceiptKey) -> bool {
        require!(
            env::predecessor_account_id() == self.verifier,
            "Only verifier"
        );
        require!(self.claims.get(&key).is_some(), "Unknown receipt");
        let before = env::storage_usage();
        let fresh = self.disputes.get(&key) != Some(&true);
        if fresh {
            self.disputes.insert(key, true);
            self.disputes.flush();
        }
        let bytes = env::storage_usage().saturating_sub(before);
        let cost = env::storage_byte_cost()
            .as_yoctonear()
            .checked_mul(u128::from(bytes))
            .expect("Storage cost overflow");
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, "Insufficient storage deposit");
        if attached > cost {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(attached - cost))
                .detach();
        }
        fresh
    }

    pub fn is_disputed(&self, key: ReceiptKey) -> bool {
        self.disputes.get(&key) == Some(&true)
    }

    pub fn get_active_claim(&self, key: ReceiptKey) -> Option<Claim> {
        if self.disputes.get(&key) == Some(&true) {
            None
        } else {
            self.claims.get(&key).cloned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn account(name: &str) -> AccountId {
        name.parse().unwrap()
    }
    fn context(caller: &str, amount: NearToken) {
        let mut builder = VMContextBuilder::new();
        builder
            .predecessor_account_id(account(caller))
            .attached_deposit(amount);
        testing_env!(builder.build());
    }
    fn key() -> ReceiptKey {
        ReceiptKey {
            chain_id: U64(46630),
            transaction_hash: [1; 32],
            log_index: 0,
        }
    }
    fn claim() -> Claim {
        Claim {
            representation: account("token.testnet"),
            token_address: "0x0000000000000000000000000000000000000001".into(),
            custody_domain: "custody".into(),
            mapping_version: U64(1),
            beneficiary: account("alice.testnet"),
            refund_address: [0xbe; 20],
            battle_id: U64(1),
            actual_received: U128(98),
            block_number: U64(3),
            block_hash: [2; 32],
            finalized_head_number: U64(4),
            finalized_head_hash: [3; 32],
            evidence_hash: [4; 32],
        }
    }
    fn registry() -> ReceiptRegistry {
        context("owner.testnet", NearToken::from_near(1));
        let mut registry =
            ReceiptRegistry::new(account("owner.testnet"), account("verifier.testnet"));
        registry.set_representation(account("token.testnet"), true);
        registry.set_representation(account("other.testnet"), true);
        context("verifier.testnet", NearToken::from_near(1));
        registry
    }
    #[test]
    fn same_receipt_is_idempotent_and_bound_to_one_representation() {
        let mut registry = registry();
        assert!(registry.attest(key(), claim()));
        assert!(!registry.attest(key(), claim()));
        assert_eq!(registry.get_claim(key()), Some(claim()));
    }
    #[test]
    #[should_panic(expected = "Conflicting receipt claim")]
    fn same_receipt_cannot_be_claimed_by_another_representation() {
        let mut registry = registry();
        registry.attest(key(), claim());
        let mut conflicting = claim();
        conflicting.representation = account("other.testnet");
        registry.attest(key(), conflicting);
    }
    #[test]
    #[should_panic(expected = "Missing refund address")]
    fn claim_without_refund_address_is_rejected() {
        let mut registry = registry();
        let mut invalid = claim();
        invalid.refund_address = [0; 20];
        registry.attest(key(), invalid);
    }

    #[test]
    #[should_panic(expected = "Conflicting receipt claim")]
    fn refund_address_is_immutable_claim_data() {
        let mut registry = registry();
        registry.attest(key(), claim());
        let mut changed = claim();
        changed.refund_address = [0xca; 20];
        registry.attest(key(), changed);
    }

    #[test]
    #[should_panic(expected = "Only verifier")]
    fn untrusted_caller_cannot_consume_receipt() {
        let mut registry = registry();
        context("attacker.testnet", NearToken::from_near(1));
        registry.attest(key(), claim());
    }
    #[test]
    #[should_panic(expected = "Receipt after finalized head")]
    fn receipt_ahead_of_finalized_head_is_rejected() {
        let mut registry = registry();
        let mut invalid = claim();
        invalid.block_number = U64(5);
        registry.attest(key(), invalid);
    }

    #[test]
    fn verifier_rotation_keeps_existing_claims_and_revoked_representations_cannot_receive_new_claims(
    ) {
        let mut registry = registry();
        registry.attest(key(), claim());
        context("owner.testnet", NearToken::from_yoctonear(1));
        registry.set_verifier(account("new-verifier.testnet"));
        context("owner.testnet", NearToken::from_near(1));
        registry.set_representation(account("token.testnet"), false);
        assert_eq!(registry.get_claim(key()), Some(claim()));
        assert_eq!(registry.verifier, account("new-verifier.testnet"));
        assert_eq!(
            registry.representations.get(&account("token.testnet")),
            Some(&false)
        );
    }

    #[test]
    #[should_panic(expected = "Representation not authorized")]
    fn unregistered_representation_is_rejected() {
        let mut registry = registry();
        let mut unregistered = claim();
        unregistered.representation = account("unknown.testnet");
        registry.attest(key(), unregistered);
    }

    #[test]
    fn dispute_retains_the_original_claim_and_cannot_release_the_key() {
        let mut registry = registry();
        registry.attest(key(), claim());
        assert!(registry.dispute(key()));
        assert!(!registry.dispute(key()));
        assert!(registry.is_disputed(key()));
        assert_eq!(registry.get_claim(key()), Some(claim()));
        assert_eq!(registry.get_active_claim(key()), None);
    }
}
