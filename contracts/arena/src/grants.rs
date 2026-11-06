//! Player-agent grants: explicit user delegation enforced on-chain
//! (docs/openspec/.../arena-player-agents). Infrastructure roles hold no
//! player-spending authority; a grant is the only way an agent can spend.

use crate::types::Grant;
use near_sdk::{env, require, AccountId};

/// Why an action under a grant is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantError {
    UnknownGrant,
    Revoked,
    Expired,
    MethodNotAllowed,
    AssetNotAllowed,
    ChainNotAllowed,
    BudgetExceeded,
    DestinationNotAllowed,
}

/// An action an agent wants to take under a grant.
pub struct ActionRequest {
    pub method: &'static str,
    /// Backing representation account the spend targets.
    pub asset: AccountId,
    pub chain_id: u64,
    /// Units requested; `None` for non-spending actions.
    pub amount: Option<u128>,
    /// Optional spend destination backing account.
    pub destination: Option<AccountId>,
}

/// Deterministic policy check. Subagents/agents MUST call this before any
/// user-delegated action; the same check runs on-chain at spend time.
pub fn authorize(grant: &Grant, action: &ActionRequest, now_ns: u64) -> Result<(), GrantError> {
    if grant.revoked {
        return Err(GrantError::Revoked);
    }
    if now_ns >= grant.expires_at_ns.0 {
        return Err(GrantError::Expired);
    }
    if !grant.methods.iter().any(|m| m == action.method) {
        return Err(GrantError::MethodNotAllowed);
    }
    if !grant.assets.iter().any(|a| a == &action.asset) {
        return Err(GrantError::AssetNotAllowed);
    }
    if !grant.chains.contains(&action.chain_id) {
        return Err(GrantError::ChainNotAllowed);
    }
    if let Some(destination) = &action.destination {
        if !grant.assets.iter().any(|a| a == destination) {
            return Err(GrantError::DestinationNotAllowed);
        }
    }
    if let Some(amount) = action.amount {
        let budget = grant
            .budget
            .iter()
            .find(|(asset, _)| asset == &action.asset)
            .map(|(_, units)| units.0)
            .unwrap_or(0);
        if amount > budget {
            return Err(GrantError::BudgetExceeded);
        }
    }
    Ok(())
}

/// Decrements a grant's per-asset budget after a successful on-chain spend.
/// Panics if the budget cannot cover `amount` (atomic rejection).
pub fn spend(grant: &mut Grant, asset: &AccountId, amount: u128) {
    require!(amount > 0, "Zero spend");
    for (budget_asset, units) in grant.budget.iter_mut() {
        if budget_asset == asset {
            require!(units.0 >= amount, "Grant budget exceeded");
            units.0 -= amount;
            return;
        }
    }
    env::panic_str("Grant has no budget for this asset");
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::json_types::{U128, U64};

    fn acc(name: &str) -> AccountId {
        format!("{name}.testnet").parse().unwrap()
    }

    fn grant() -> Grant {
        Grant {
            id: 1,
            grantor: acc("alice"),
            agent: acc("agent"),
            budget: vec![(acc("backing_a"), U128(1_000))],
            methods: vec!["deposit".to_string()],
            chains: vec![46630],
            assets: vec![acc("backing_a")],
            expires_at_ns: U64(10_000),
            revoked: false,
        }
    }

    fn action(amount: u128) -> ActionRequest {
        ActionRequest {
            method: "deposit",
            asset: acc("backing_a"),
            chain_id: 46630,
            amount: Some(amount),
            destination: None,
        }
    }

    fn action_with_destination(amount: u128, destination: AccountId) -> ActionRequest {
        ActionRequest {
            destination: Some(destination),
            ..action(amount)
        }
    }

    #[test]
    fn authorized_action_within_budget() {
        assert_eq!(authorize(&grant(), &action(500), 5_000), Ok(()));
    }

    #[test]
    fn budget_exceeded_is_rejected_atomically() {
        assert_eq!(
            authorize(&grant(), &action(1_001), 5_000),
            Err(GrantError::BudgetExceeded)
        );
    }

    #[test]
    fn expired_or_revoked_rejected() {
        assert_eq!(authorize(&grant(), &action(100), 10_000), Err(GrantError::Expired));
        let revoked = Grant {
            revoked: true,
            ..grant()
        };
        assert_eq!(authorize(&revoked, &action(100), 5_000), Err(GrantError::Revoked));
    }

    #[test]
    fn method_and_chain_and_asset_checks() {
        let mut g = grant();
        g.methods = vec!["resolve_round".to_string()];
        assert_eq!(authorize(&g, &action(100), 5_000), Err(GrantError::MethodNotAllowed));

        let mut g = grant();
        g.chains = vec![1];
        assert_eq!(authorize(&g, &action(100), 5_000), Err(GrantError::ChainNotAllowed));

        let mut g = grant();
        g.assets = vec![acc("other")];
        assert_eq!(authorize(&g, &action(100), 5_000), Err(GrantError::AssetNotAllowed));
    }

    #[test]
    fn destination_outside_the_assets_is_rejected() {
        let other = acc("backing_b");
        assert_eq!(
            authorize(&grant(), &action_with_destination(100, other), 5_000),
            Err(GrantError::DestinationNotAllowed)
        );
    }

    #[test]
    fn spend_decrements_and_never_goes_negative() {
        let mut g = grant();
        spend(&mut g, &acc("backing_a"), 400);
        assert_eq!(g.budget[0].1, U128(600));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            spend(&mut g, &acc("backing_a"), 601)
        }));
        assert!(result.is_err());
        assert_eq!(g.budget[0].1, U128(600));
    }
}