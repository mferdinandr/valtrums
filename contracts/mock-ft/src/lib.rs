//! Open-mint NEP-141 token for testnet and sandbox use (mock USDC and mock meme coins).
//! Anyone can mint: never deploy this where the tokens have value.

use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{near, AccountId, BorshStorageKey, PanicOnDefault, PromiseOrValue};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Token,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockFt {
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
}

#[near]
impl MockFt {
    #[init]
    pub fn new(name: String, symbol: String, decimals: u8) -> Self {
        Self {
            token: FungibleToken::new(StorageKey::Token),
            metadata: FungibleTokenMetadata {
                spec: FT_METADATA_SPEC.to_string(),
                name,
                symbol,
                icon: None,
                reference: None,
                reference_hash: None,
                decimals,
            },
        }
    }

    /// Mints to `account_id`, registering it if needed. Open to everyone (mock token).
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
    }
}

#[near]
impl FungibleTokenCore for MockFt {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for MockFt {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        self.token
            .ft_resolve_transfer(sender_id, receiver_id, amount)
    }
}

#[near]
impl StorageManagement for MockFt {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<near_sdk::NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.storage_unregister(force)
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for MockFt {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_contract_standards::fungible_token::FungibleTokenCore;

    fn acc(name: &str) -> AccountId {
        format!("{name}.testnet").parse().unwrap()
    }

    #[test]
    fn mint_registers_and_credits() {
        let mut ft = MockFt::new("Mock USDC".into(), "USDC".into(), 6);
        ft.mint(acc("alice"), U128(1_000_000));
        assert_eq!(ft.ft_balance_of(acc("alice")), U128(1_000_000));
        assert_eq!(ft.ft_total_supply(), U128(1_000_000));
        ft.mint(acc("alice"), U128(5));
        assert_eq!(ft.ft_balance_of(acc("alice")), U128(1_000_005));
    }

    #[test]
    fn metadata_reports_decimals() {
        let ft = MockFt::new("Mock PEPE".into(), "PEPE".into(), 18);
        assert_eq!(ft.ft_metadata().decimals, 18);
        assert_eq!(ft.ft_metadata().symbol, "PEPE");
    }
}
