use near_sdk::{near, AccountId};

/// Router contract: swaps USDC into a side's meme coin and deposits it atomically.
#[near(contract_state)]
pub struct Router {
    owner: AccountId,
}

impl Default for Router {
    fn default() -> Self {
        near_sdk::env::panic_str("contract is not initialized")
    }
}

#[near]
impl Router {
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
        let contract = Router::new(owner.clone());
        assert_eq!(contract.get_owner(), owner);
    }
}
