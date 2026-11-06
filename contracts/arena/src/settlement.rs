//! Per-token settlement allocation (docs/token-economics.md).
//!
//! Fee is collected once per losing token as `floor(L / 1000)`; the fraction
//! stays with the winner pool. User-created battles split the fee 50:50 with
//! the odd unit to the protocol; protocol-created battles give the whole fee
//! to the protocol. Largest remainder applies only within the winner pool,
//! with canonical NEAR account-ID tie ordering.

use crate::scoring::U256;
use near_sdk::AccountId;

/// Deterministic split of one losing vault.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VaultSplit {
    /// Winner pool: `L - fee`.
    pub winner_pool: u128,
    pub creator_fee: u128,
    pub protocol_fee: u128,
}

impl VaultSplit {
    /// Conservation: `winner_pool + creator_fee + protocol_fee == vault`.
    pub fn conserves(self, vault: u128) -> bool {
        self.winner_pool
            .checked_add(self.creator_fee)
            .and_then(|v| v.checked_add(self.protocol_fee))
            == Some(vault)
    }
}

/// Splits a losing vault: `fee = floor(L / 1000)` first, then the fee split.
pub fn split_loser_vault(vault: u128, protocol_created: bool) -> VaultSplit {
    let fee = vault / 1000;
    let winner_pool = vault - fee;
    let (creator_fee, protocol_fee) = if protocol_created {
        (0, fee)
    } else {
        let creator = fee / 2;
        (creator, fee - creator)
    };
    VaultSplit {
        winner_pool,
        creator_fee,
        protocol_fee,
    }
}

/// Distributes the winner pool by locked units with deterministic largest
/// remainder. `weights` maps beneficiary -> locked winning units; ties on
/// equal remainders break by canonical NEAR account ID bytes ascending.
/// Returns allocations in the same order, summing exactly to `pool`.
pub fn distribute_winner_pool(
    pool: u128,
    weights: &[(AccountId, u128)],
    total_weight: u128,
) -> Vec<(AccountId, u128)> {
    assert!(total_weight > 0, "Empty winner community");
    let pool_big = U256::from(pool);
    let total_big = U256::from(total_weight);

    let mut floors: Vec<(AccountId, u128, U256)> = weights
        .iter()
        .map(|(account, units)| {
            let units_big = U256::from(*units);
            let ideal = pool_big * units_big;
            let floor = (ideal / total_big).as_u128();
            let remainder = ideal % total_big;
            (account.clone(), floor, remainder)
        })
        .collect();

    let floored_sum: u128 = floors.iter().map(|(_, floor, _)| *floor).sum();
    let mut remaining = pool - floored_sum;

    // Descending remainder; canonical account-ID bytes ascending on ties.
    floors.sort_by(|a, b| {
        b.2.cmp(&a.2).then_with(|| {
            let a_bytes = a.0.as_bytes().to_vec();
            let b_bytes = b.0.as_bytes().to_vec();
            a_bytes.cmp(&b_bytes)
        })
    });

    for (_, floor, _) in floors.iter_mut() {
        if remaining == 0 {
            break;
        }
        *floor += 1;
        remaining -= 1;
    }
    assert_eq!(remaining, 0, "Largest remainder must consume the pool");

    floors
        .into_iter()
        .map(|(account, floor, _)| (account, floor))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acc(name: &str) -> AccountId {
        format!("{name}.testnet").parse().unwrap()
    }

    #[test]
    fn two_community_example() {
        // A wins over 100,000 B units with 60/40 weights.
        let split = split_loser_vault(100_000, false);
        assert_eq!(split.winner_pool, 99_900);
        assert_eq!(split.creator_fee, 50);
        assert_eq!(split.protocol_fee, 50);
        assert!(split.conserves(100_000));

        let shares = distribute_winner_pool(99_900, &[(acc("alice"), 600), (acc("bob"), 400)], 1000);
        let map: std::collections::BTreeMap<_, _> = shares.into_iter().collect();
        assert_eq!(map[&acc("alice")], 59_940);
        assert_eq!(map[&acc("bob")], 39_960);
    }

    #[test]
    fn uneven_vault_example() {
        // 10,003 units: reward 9,993; creator 5; protocol 5.
        let split = split_loser_vault(10_003, false);
        assert_eq!((split.winner_pool, split.creator_fee, split.protocol_fee), (9_993, 5, 5));
    }

    #[test]
    fn tiny_vault_pays_no_fee() {
        let split = split_loser_vault(999, false);
        assert_eq!(split.winner_pool, 999);
        assert_eq!(split.creator_fee, 0);
        assert_eq!(split.protocol_fee, 0);
    }

    #[test]
    fn odd_fee_goes_to_protocol() {
        // 1,000 units: fee 1, creator 0, protocol 1.
        let split = split_loser_vault(1_000, false);
        assert_eq!((split.winner_pool, split.creator_fee, split.protocol_fee), (999, 0, 1));
    }

    #[test]
    fn protocol_created_receives_whole_fee() {
        let split = split_loser_vault(1_000, true);
        assert_eq!((split.winner_pool, split.creator_fee, split.protocol_fee), (999, 0, 1));
        let split = split_loser_vault(100_000, true);
        assert_eq!((split.winner_pool, split.creator_fee, split.protocol_fee), (99_900, 0, 100));
    }

    #[test]
    fn largest_remainder_1_2_3_example() {
        // Pool 9,993, weights 1:2:3 with Alice/Bob/Carol -> 1,666/3,331/4,996.
        let shares = distribute_winner_pool(
            9_993,
            &[(acc("alice"), 1), (acc("bob"), 2), (acc("carol"), 3)],
            6,
        );
        let map: std::collections::BTreeMap<_, _> = shares.into_iter().collect();
        assert_eq!(map[&acc("alice")], 1_666);
        assert_eq!(map[&acc("bob")], 3_331);
        assert_eq!(map[&acc("carol")], 4_996);
    }

    #[test]
    fn tie_break_uses_canonical_account_order() {
        // Two equal remainders; the canonical smaller account gets the unit.
        let shares = distribute_winner_pool(5, &[(acc("bob"), 1), (acc("alice"), 1)], 2);
        let map: std::collections::BTreeMap<_, _> = shares.into_iter().collect();
        assert_eq!(map[&acc("alice")], 3);
        assert_eq!(map[&acc("bob")], 2);
    }

    #[test]
    fn every_pool_is_conserved() {
        for vault in [1u128, 999, 1_000, 10_003, 100_000, u128::MAX / 3] {
            for protocol in [false, true] {
                let split = split_loser_vault(vault, protocol);
                assert!(split.conserves(vault), "vault {vault} protocol {protocol}");
            }
        }
    }
}