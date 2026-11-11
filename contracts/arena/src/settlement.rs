//! Deterministic per-token settlement arithmetic.
//!
//! For one losing vault it computes the snapshotted fee once, splits that fee
//! between creator and protocol, and shares the remainder among the final
//! winner's participants by largest remainder. Every unit is allocated, none
//! is created, and the result does not depend on input order. It does not read
//! lifecycle state, authenticate callers or move backing: the adapter supplies
//! the frozen vault and weights and later calls the backing hand-off.
use crate::lifecycle::FeePolicy;
use crate::math::wide::U256;
use near_sdk::{env, AccountId};
use std::collections::BTreeMap;

const BPS: u128 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettlementError {
    /// Fee or creator share is outside 0 through 10000 basis points.
    InvalidBps,
    /// The losing vault is empty or the weights are empty or inconsistent.
    InvalidInput,
    Overflow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recipient {
    Winner,
    Creator,
    Protocol,
}

/// One asset-bound amount owed to one account for one losing token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entitlement {
    /// Immutable identity of this allocation, unique per battle, losing
    /// community, recipient kind and account.
    pub id: [u8; 32],
    pub beneficiary: AccountId,
    pub kind: Recipient,
    pub amount: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultAllocation {
    pub community: u32,
    pub fee: u128,
    pub creator_fee: u128,
    pub protocol_fee: u128,
    pub winner_pool: u128,
    /// Non-zero entitlements only: winners in canonical account order, then
    /// creator and protocol.
    pub entitlements: Vec<Entitlement>,
}

fn wide(value: u128) -> U256 {
    U256::from(value)
}

fn narrow(value: U256) -> Result<u128, SettlementError> {
    if value > U256::from(u128::MAX) {
        Err(SettlementError::Overflow)
    } else {
        Ok(value.low_u128())
    }
}

pub(crate) fn part(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

/// Immutable allocation identity, so a retry can never allocate twice.
pub fn entitlement_id(
    battle_id: u64,
    losing_community: u32,
    kind: Recipient,
    beneficiary: &AccountId,
) -> [u8; 32] {
    let mut data = b"valtrum/allocation/v1".to_vec();
    part(&mut data, &battle_id.to_be_bytes());
    part(&mut data, &losing_community.to_be_bytes());
    part(&mut data, &[kind as u8]);
    part(&mut data, beneficiary.as_str().as_bytes());
    env::sha256_array(&data)
}

/// Allocate one losing vault. `winners` are the final winning community's
/// participants with their credited deposits; duplicates are aggregated and
/// the order is irrelevant. Their total must equal `winning_vault`.
pub fn allocate_vault(
    battle_id: u64,
    losing_community: u32,
    losing_vault: u128,
    fee: &FeePolicy,
    winners: &[(AccountId, u128)],
    winning_vault: u128,
) -> Result<VaultAllocation, SettlementError> {
    let (fee_bps, share_bps) = (u128::from(fee.fee_bps), u128::from(fee.creator_share_bps));
    if fee_bps > BPS || share_bps > BPS {
        return Err(SettlementError::InvalidBps);
    }
    if losing_vault == 0 || winning_vault == 0 {
        return Err(SettlementError::InvalidInput);
    }
    let mut weights: BTreeMap<&[u8], (&AccountId, u128)> = BTreeMap::new();
    let mut total = 0u128;
    for (account, deposit) in winners {
        if *deposit == 0 {
            return Err(SettlementError::InvalidInput);
        }
        let entry = weights
            .entry(account.as_str().as_bytes())
            .or_insert((account, 0));
        entry.1 = entry
            .1
            .checked_add(*deposit)
            .ok_or(SettlementError::Overflow)?;
        total = total
            .checked_add(*deposit)
            .ok_or(SettlementError::Overflow)?;
    }
    if total != winning_vault {
        return Err(SettlementError::InvalidInput);
    }

    let total_fee = narrow(wide(losing_vault) * wide(fee_bps) / wide(BPS))?;
    let winner_pool = losing_vault - total_fee;
    let (creator_fee, protocol_fee) = if fee.protocol_created {
        (0, total_fee)
    } else {
        let creator = narrow(wide(total_fee) * wide(share_bps) / wide(BPS))?;
        (creator, total_fee - creator)
    };

    // Floor shares, then hand the leftover units to the largest remainders,
    // breaking ties by ascending account bytes.
    let mut shares: Vec<(&AccountId, u128, U256)> = Vec::with_capacity(weights.len());
    let mut assigned = 0u128;
    for (account, deposit) in weights.values() {
        let product = wide(winner_pool) * wide(*deposit);
        let share = narrow(product / wide(winning_vault))?;
        let remainder = product % wide(winning_vault);
        assigned = assigned
            .checked_add(share)
            .ok_or(SettlementError::Overflow)?;
        shares.push((account, share, remainder));
    }
    let mut leftover = winner_pool - assigned;
    let mut order: Vec<usize> = (0..shares.len()).collect();
    order.sort_by(|a, b| {
        shares[*b]
            .2
            .cmp(&shares[*a].2)
            .then_with(|| shares[*a].0.as_str().cmp(shares[*b].0.as_str()))
    });
    for index in order {
        if leftover == 0 {
            break;
        }
        shares[index].1 += 1;
        leftover -= 1;
    }
    if leftover != 0 {
        return Err(SettlementError::InvalidInput);
    }

    let mut entitlements = Vec::new();
    let mut push = |kind: Recipient, beneficiary: &AccountId, amount: u128| {
        if amount > 0 {
            entitlements.push(Entitlement {
                id: entitlement_id(battle_id, losing_community, kind, beneficiary),
                beneficiary: beneficiary.clone(),
                kind,
                amount,
            });
        }
    };
    for (account, amount, _) in &shares {
        push(Recipient::Winner, account, *amount);
    }
    push(Recipient::Creator, &fee.creator, creator_fee);
    push(Recipient::Protocol, &fee.protocol, protocol_fee);
    let distributed = entitlements.iter().map(|e| e.amount).sum::<u128>();
    if distributed != losing_vault {
        return Err(SettlementError::InvalidInput);
    }
    Ok(VaultAllocation {
        community: losing_community,
        fee: total_fee,
        creator_fee,
        protocol_fee,
        winner_pool,
        entitlements,
    })
}

/// Allocate every losing vault of a battle whose winner is recorded, reading
/// each original vault from the frozen snapshot (communities eliminated in
/// overtime included) and using the winning vault as the weight denominator.
/// `winners` are the winning community's participants and their deposits.
pub fn allocate_battle(
    battle_id: u64,
    battle: &crate::lifecycle::Battle,
    winners: &[(AccountId, u128)],
) -> Result<Vec<VaultAllocation>, SettlementError> {
    let hold = battle
        .principal_hold()
        .ok_or(SettlementError::InvalidInput)?;
    let mut allocations = Vec::new();
    for community in 0..battle.community_count() as u32 {
        if community == hold.community {
            continue;
        }
        let loser = battle
            .losing_vault(community)
            .map_err(|_| SettlementError::InvalidInput)?;
        // A community that never held a deposit was excluded at lock.
        if loser.amount == 0 {
            continue;
        }
        allocations.push(allocate_vault(
            battle_id,
            community,
            loser.amount,
            &loser.fee,
            winners,
            hold.amount,
        )?);
    }
    Ok(allocations)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(name: &str) -> AccountId {
        name.parse().expect("account")
    }
    fn fee(protocol_created: bool) -> FeePolicy {
        FeePolicy {
            fee_bps: 10,
            creator_share_bps: 5000,
            creator: account("creator.testnet"),
            protocol: account("protocol.testnet"),
            protocol_created,
        }
    }
    fn amounts(allocation: &VaultAllocation) -> Vec<(String, u128)> {
        allocation
            .entitlements
            .iter()
            .map(|e| (e.beneficiary.to_string(), e.amount))
            .collect()
    }
    fn weights(list: &[(&str, u128)]) -> Vec<(AccountId, u128)> {
        list.iter().map(|(n, d)| (account(n), *d)).collect()
    }
    fn get(a: &VaultAllocation, name: &str) -> u128 {
        a.entitlements
            .iter()
            .filter(|e| e.beneficiary.as_str() == name)
            .map(|e| e.amount)
            .sum()
    }

    #[test]
    fn two_community_example_splits_100000_units() {
        let winners = weights(&[("alice.testnet", 600), ("bob.testnet", 400)]);
        let a = allocate_vault(1, 1, 100_000, &fee(false), &winners, 1_000).expect("allocate");
        assert_eq!((a.fee, a.winner_pool), (100, 99_900));
        assert_eq!(get(&a, "alice.testnet"), 59_940);
        assert_eq!(get(&a, "bob.testnet"), 39_960);
        assert_eq!(get(&a, "creator.testnet"), 50);
        assert_eq!(get(&a, "protocol.testnet"), 50);
    }

    #[test]
    fn fee_split_rounds_down_for_creator_and_remainder_to_protocol() {
        let one = weights(&[("alice.testnet", 5)]);
        let a = allocate_vault(1, 1, 10_003, &fee(false), &one, 5).expect("allocate");
        assert_eq!(
            (
                get(&a, "alice.testnet"),
                get(&a, "creator.testnet"),
                get(&a, "protocol.testnet")
            ),
            (9_993, 5, 5)
        );
        // 999 units: no fee, so no creator or protocol entitlement exists.
        for protocol_created in [false, true] {
            let a = allocate_vault(1, 1, 999, &fee(protocol_created), &one, 5).expect("allocate");
            assert_eq!((a.fee, a.winner_pool), (0, 999));
            assert_eq!(a.entitlements.len(), 1);
        }
        // 1000 units: fee 1; a user creator gets 0 and protocol the whole unit.
        let a = allocate_vault(1, 1, 1_000, &fee(false), &one, 5).expect("allocate");
        assert_eq!(
            (a.fee, a.creator_fee, a.protocol_fee, a.winner_pool),
            (1, 0, 1, 999)
        );
        assert_eq!(get(&a, "creator.testnet"), 0);
        let a = allocate_vault(1, 1, 1_000, &fee(true), &one, 5).expect("allocate");
        assert_eq!((a.creator_fee, a.protocol_fee), (0, 1));
    }

    #[test]
    fn protocol_creator_receives_the_whole_fee_once() {
        let winners = weights(&[("alice.testnet", 1)]);
        let a = allocate_vault(1, 1, 100_000, &fee(true), &winners, 1).expect("allocate");
        assert_eq!(get(&a, "alice.testnet"), 99_900);
        assert_eq!(get(&a, "protocol.testnet"), 100);
        assert_eq!(get(&a, "creator.testnet"), 0);
    }

    #[test]
    fn dust_goes_to_largest_remainders_then_account_order_independent_of_input_order() {
        // Pool 9993 shared 1:2:3 leaves one unit; Alice and Carol tie on remainder.
        let mut policy = fee(false);
        policy.fee_bps = 0;
        let forward = weights(&[
            ("alice.testnet", 1),
            ("bob.testnet", 2),
            ("carol.testnet", 3),
        ]);
        let backward = weights(&[
            ("carol.testnet", 3),
            ("bob.testnet", 2),
            ("alice.testnet", 1),
        ]);
        let a = allocate_vault(1, 1, 9_993, &policy, &forward, 6).expect("allocate");
        let b = allocate_vault(1, 1, 9_993, &policy, &backward, 6).expect("allocate");
        assert_eq!(a, b);
        assert_eq!(
            amounts(&a),
            vec![
                ("alice.testnet".to_string(), 1_666),
                ("bob.testnet".to_string(), 3_331),
                ("carol.testnet".to_string(), 4_996),
            ]
        );
        // Duplicate rows for one account aggregate before sharing.
        let split = weights(&[
            ("alice.testnet", 1),
            ("bob.testnet", 2),
            ("carol.testnet", 1),
            ("carol.testnet", 2),
        ]);
        assert_eq!(allocate_vault(1, 1, 9_993, &policy, &split, 6), Ok(a));
    }

    #[test]
    fn every_unit_is_allocated_across_many_shapes() {
        for vault in [
            1u128,
            2,
            7,
            999,
            1_000,
            1_001,
            10_003,
            123_456_789,
            u128::MAX / 3,
        ] {
            for (fee_bps, share) in [
                (0u16, 0u16),
                (10, 5000),
                (10, 10_000),
                (333, 3_333),
                (10_000, 10_000),
            ] {
                for protocol_created in [false, true] {
                    let mut policy = fee(protocol_created);
                    policy.fee_bps = fee_bps;
                    policy.creator_share_bps = share;
                    let winners = weights(&[
                        ("a.testnet", 7),
                        ("b.testnet", 13),
                        ("c.testnet", 29),
                        ("d.testnet", 1),
                    ]);
                    let a = allocate_vault(2, 3, vault, &policy, &winners, 50).expect("allocate");
                    let sum: u128 = a.entitlements.iter().map(|e| e.amount).sum();
                    assert_eq!(sum, vault, "vault {vault} fee {fee_bps} share {share}");
                    assert_eq!(a.fee, a.creator_fee + a.protocol_fee);
                    assert_eq!(a.fee + a.winner_pool, vault);
                    assert!(a.entitlements.iter().all(|e| e.amount > 0));
                }
            }
        }
    }

    #[test]
    fn invalid_configuration_and_inconsistent_weights_are_rejected() {
        let winners = weights(&[("alice.testnet", 5)]);
        let mut bad = fee(false);
        bad.fee_bps = 10_001;
        assert_eq!(
            allocate_vault(1, 1, 100, &bad, &winners, 5),
            Err(SettlementError::InvalidBps)
        );
        let mut bad = fee(false);
        bad.creator_share_bps = 10_001;
        assert_eq!(
            allocate_vault(1, 1, 100, &bad, &winners, 5),
            Err(SettlementError::InvalidBps)
        );
        // Boundary values are valid.
        let mut edge = fee(false);
        edge.fee_bps = 10_000;
        edge.creator_share_bps = 0;
        assert!(allocate_vault(1, 1, 100, &edge, &winners, 5).is_ok());
        assert_eq!(
            allocate_vault(1, 1, 0, &fee(false), &winners, 5),
            Err(SettlementError::InvalidInput)
        );
        assert_eq!(
            allocate_vault(1, 1, 100, &fee(false), &[], 5),
            Err(SettlementError::InvalidInput)
        );
        // Weights must add up to the final winning vault.
        assert_eq!(
            allocate_vault(1, 1, 100, &fee(false), &winners, 6),
            Err(SettlementError::InvalidInput)
        );
        assert_eq!(
            allocate_vault(
                1,
                1,
                100,
                &fee(false),
                &weights(&[("alice.testnet", 0), ("bob.testnet", 5)]),
                5
            ),
            Err(SettlementError::InvalidInput)
        );
    }

    #[test]
    fn allocation_ids_are_unique_per_battle_token_kind_and_account() {
        let alice = account("alice.testnet");
        let base = entitlement_id(1, 1, Recipient::Winner, &alice);
        assert_eq!(base, entitlement_id(1, 1, Recipient::Winner, &alice));
        assert_ne!(base, entitlement_id(2, 1, Recipient::Winner, &alice));
        assert_ne!(base, entitlement_id(1, 2, Recipient::Winner, &alice));
        assert_ne!(base, entitlement_id(1, 1, Recipient::Creator, &alice));
        assert_ne!(
            base,
            entitlement_id(1, 1, Recipient::Winner, &account("bob.testnet"))
        );
        // Two losing tokens settle independently and cannot overwrite each other.
        let winners = weights(&[("alice.testnet", 5)]);
        let b = allocate_vault(1, 1, 100_000, &fee(false), &winners, 5).expect("b");
        let c = allocate_vault(1, 2, 200_000, &fee(false), &winners, 5).expect("c");
        assert_eq!(
            (get(&c, "alice.testnet"), get(&c, "creator.testnet")),
            (199_800, 100)
        );
        let ids: Vec<_> = b
            .entitlements
            .iter()
            .chain(&c.entitlements)
            .map(|e| e.id)
            .collect();
        let unique: std::collections::BTreeSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len());
    }
}
