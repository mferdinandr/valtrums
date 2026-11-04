use near_sdk::{near, AccountId};

pub mod math;
pub mod types;

/// Battle arena contract: battle lifecycle, vaults, positions and settlement.
#[near(contract_state)]
pub struct Arena {
    owner: AccountId,
}

impl Default for Arena {
    fn default() -> Self {
        near_sdk::env::panic_str("contract is not initialized")
    }
}

#[near]
impl Arena {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self { owner }
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_sets_owner() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let contract = Arena::new(owner.clone());
        assert_eq!(contract.get_owner(), owner);
    }
}
