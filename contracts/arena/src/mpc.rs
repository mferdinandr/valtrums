//! Reservation-bound foreign-chain signing (docs/openspec/.../arena-chain-signatures).
//!
//! The signing policy reconstructs the allowed chain, token, recipient,
//! amount, custody path, nonce and payload from an exclusive authorized
//! liability reservation. A relayer cannot change the recipient or amount;
//! an infrastructure credential cannot request arbitrary spending. A
//! signature alone never confirms a payout: final matching execution
//! evidence is required before backing is consumed.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::Value;
use near_sdk::{near, AccountId};

/// 256-bit unsigned integer for scalar range checks.
pub use crate::scoring::U256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MpcError {
    BadAddress,
    BadSignature,
}

// ─── RLP encoding ────────────────────────────────────────────────────────

pub fn rlp_bytes(data: &[u8]) -> Vec<u8> {
    if data.len() == 1 && data[0] < 0x80 {
        return data.to_vec();
    }
    rlp_encoded_bytes(0x80, data)
}

fn rlp_encoded_bytes(offset: u8, data: &[u8]) -> Vec<u8> {
    if data.len() <= 55 {
        let mut out = Vec::with_capacity(1 + data.len());
        out.push(offset + data.len() as u8);
        out.extend_from_slice(data);
        out
    } else {
        let len_bytes = u64_to_be_bytes(data.len() as u64);
        let mut out = Vec::with_capacity(1 + len_bytes.len() + data.len());
        out.push(offset + 55 + len_bytes.len() as u8);
        out.extend_from_slice(&len_bytes);
        out.extend_from_slice(data);
        out
    }
}

fn u64_to_be_bytes(mut value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    while value > 0 {
        out.push((value & 0xff) as u8);
        value >>= 8;
    }
    out.reverse();
    out
}

/// Encodes a big-endian number with leading zeros dropped (RLP integer rule).
pub fn rlp_uint_bytes(be: &[u8]) -> Vec<u8> {
    let trimmed = be
        .iter()
        .skip_while(|byte| **byte == 0)
        .cloned()
        .collect::<Vec<_>>();
    if trimmed.is_empty() {
        vec![0x80]
    } else {
        rlp_bytes(&trimmed)
    }
}

pub fn rlp_u128(value: u128) -> Vec<u8> {
    rlp_uint_bytes(&value.to_be_bytes())
}

pub fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let joined: Vec<u8> = items.iter().flatten().cloned().collect();
    rlp_encoded_bytes(0xc0, &joined)
}

// ─── Keccak-256 ──────────────────────────────────────────────────────────

/// Minimal keccak-f[1600] (FIPS 202) implementation for the signing hash.
pub fn keccak(data: &[u8]) -> [u8; 32] {
    const RATE: usize = 136;
    let mut state = [[0u64; 25]; 1];
    let mut padded = data.to_vec();
    padded.push(0x01);
    while padded.len() % RATE != RATE - 1 {
        padded.push(0);
    }
    padded.push(0x80);
    for chunk in padded.chunks(RATE) {
        let mut block = [0u8; RATE];
        block[..chunk.len()].copy_from_slice(chunk);
        for (i, byte) in block.iter().enumerate() {
            state[0][i / 8] ^= (*byte as u64) << (8 * (i % 8));
        }
        keccak_f1600(&mut state[0]);
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = (state[0][i / 8] >> (8 * (i % 8))) as u8;
    }
    out
}

fn rol(value: u64, shift: u32) -> u64 {
    value.rotate_left(shift)
}

fn keccak_f1600(a: &mut [u64; 25]) {
    const RC: [u64; 24] = [
        0x0000000000000001,
        0x0000000000008082,
        0x800000000000808a,
        0x8000000080008000,
        0x000000000000808b,
        0x0000000080000001,
        0x8000000080008081,
        0x8000000000008009,
        0x000000000000008a,
        0x0000000000000088,
        0x0000000080008009,
        0x000000008000000a,
        0x000000008000808b,
        0x800000000000008b,
        0x8000000000008089,
        0x8000000000008003,
        0x8000000000008002,
        0x8000000000000080,
        0x000000000000800a,
        0x800000008000000a,
        0x8000000080008081,
        0x8000000000008080,
        0x0000000080000001,
        0x8000000080008008,
    ];
    const ROT: [[u32; 5]; 5] = [
        [0, 36, 3, 41, 18],
        [1, 44, 10, 45, 2],
        [62, 6, 43, 15, 61],
        [28, 55, 25, 21, 56],
        [27, 20, 39, 8, 14],
    ];
    for rc in RC {
        let mut c = [0u64; 5];
        for x in 0..5 {
            c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
        }
        let mut d = [0u64; 5];
        for x in 0..5 {
            d[x] = c[(x + 4) % 5] ^ rol(c[(x + 1) % 5], 1);
        }
        for x in 0..5 {
            for y in 0..5 {
                a[x + 5 * y] ^= d[x];
            }
        }
        let mut b = [0u64; 25];
        for x in 0..5 {
            for y in 0..5 {
                b[y + 5 * ((2 * x + 3 * y) % 5)] = rol(a[x + 5 * y], ROT[x][y]);
            }
        }
        for x in 0..5 {
            for y in 0..5 {
                a[x + 5 * y] = b[x + 5 * y] ^ ((!b[(x + 1) % 5 + 5 * y]) & b[(x + 2) % 5 + 5 * y]);
            }
        }
        a[0] ^= rc;
    }
}

// ─── ABI encoding ────────────────────────────────────────────────────────

pub fn selector(signature: &str) -> [u8; 4] {
    let mut out = [0u8; 4];
    out.copy_from_slice(&keccak(signature.as_bytes())[..4]);
    out
}

fn word_address(address: &[u8; 20]) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(address);
    word
}

fn word_u128(value: u128) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}

/// ERC-20 `transfer(to, amount)` calldata.
pub fn erc20_transfer(to: &[u8; 20], amount: u128) -> Vec<u8> {
    let mut data = Vec::with_capacity(4 + 64);
    data.extend_from_slice(&selector("transfer(address,uint256)"));
    data.extend_from_slice(&word_address(to));
    data.extend_from_slice(&word_u128(amount));
    data
}

// ─── Addresses and hex ───────────────────────────────────────────────────

pub fn parse_address(text: &str) -> Result<[u8; 20], MpcError> {
    let cleaned = text.strip_prefix("0x").unwrap_or(text);
    if cleaned.len() != 40 {
        return Err(MpcError::BadAddress);
    }
    let bytes = hex_decode(cleaned).ok_or(MpcError::BadAddress)?;
    let mut out = [0u8; 20];
    out.copy_from_slice(&bytes);
    Ok(out)
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

pub fn hex_decode(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    let value = |byte: u8| -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    };
    text.as_bytes()
        .chunks(2)
        .map(|pair| Some((value(pair[0])? << 4) | value(pair[1])?))
        .collect()
}

// ─── EVM transactions ────────────────────────────────────────────────────

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmTx {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: U128,
    pub max_fee_per_gas: U128,
    pub gas_limit: u64,
    pub to: [u8; 20],
    pub value: U128,
    pub data: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EcdsaSignature {
    pub r: [u8; 32],
    pub s: [u8; 32],
    pub y_parity: u8,
}

impl EvmTx {
    /// Type-2 (EIP-1559) unsigned payload.
    pub fn unsigned(&self) -> Vec<u8> {
        let fields = vec![
            rlp_u128(self.chain_id.into()),
            rlp_u128(self.nonce.into()),
            rlp_u128(self.max_priority_fee_per_gas.0),
            rlp_u128(self.max_fee_per_gas.0),
            rlp_u128(self.gas_limit.into()),
            rlp_bytes(&self.to),
            rlp_u128(self.value.0),
            rlp_bytes(&self.data),
            rlp_list(&[]),
        ];
        let mut out = Vec::with_capacity(1 + 64);
        out.push(0x02);
        out.extend_from_slice(&rlp_list(&fields));
        out
    }

    pub fn signing_hash(&self) -> [u8; 32] {
        keccak(&self.unsigned())
    }

    pub fn signed(&self, signature: &EcdsaSignature) -> Vec<u8> {
        let fields = vec![
            rlp_u128(self.chain_id.into()),
            rlp_u128(self.nonce.into()),
            rlp_u128(self.max_priority_fee_per_gas.0),
            rlp_u128(self.max_fee_per_gas.0),
            rlp_u128(self.gas_limit.into()),
            rlp_bytes(&self.to),
            rlp_u128(self.value.0),
            rlp_bytes(&self.data),
            rlp_uint_bytes(&[signature.y_parity]),
            rlp_uint_bytes(&signature.r),
            rlp_uint_bytes(&signature.s),
        ];
        let mut out = Vec::with_capacity(1 + 64);
        out.push(0x02);
        out.extend_from_slice(&rlp_list(&fields));
        out
    }
}

pub fn tx_hash(signed: &[u8]) -> [u8; 32] {
    keccak(signed)
}

const SECP256K1_N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

// ─── Reservation-bound signing policy ────────────────────────────────────

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ForeignConfigInput {
    pub mpc_contract: AccountId,
    pub chain_id: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForeignConfig {
    pub mpc_contract: AccountId,
    pub chain_id: u64,
}

impl ForeignConfig {
    pub fn from_input(input: ForeignConfigInput) -> Result<Self, MpcError> {
        Ok(Self {
            mpc_contract: input.mpc_contract,
            chain_id: input.chain_id.0,
        })
    }
}

/// The allowed fields reconstructed from an exclusive authorized liability
/// reservation. Every spendable field of the transaction must equal these.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PayoutSpec {
    /// The source token contract (the community's Robinhood token).
    pub token: [u8; 20],
    /// The authorized beneficiary's Robinhood address.
    pub to: [u8; 20],
    pub amount: u128,
    /// Stable nonce bound to the payout identity; replacements reuse it.
    pub nonce: u64,
    pub chain_id: u64,
}

/// Why a proposed foreign transaction is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallError {
    BadAddress,
    ZeroAmount,
    WrongChain,
    WrongNonce,
    WrongToken,
    WrongRecipient,
    WrongAmount,
    UnexpectedValue,
    NotATransfer,
}

/// Verifies that a transaction is exactly the constrained transfer the
/// reservation authorizes. Chain, nonce, token, recipient, amount, value and
/// calldata must all match the spec reconstructed from the reservation.
pub fn verify_payout_tx(
    config: &ForeignConfig,
    spec: &PayoutSpec,
    tx: &EvmTx,
) -> Result<(), CallError> {
    if config.chain_id != spec.chain_id {
        return Err(CallError::WrongChain);
    }
    if tx.chain_id != spec.chain_id {
        return Err(CallError::WrongChain);
    }
    if tx.nonce != spec.nonce {
        return Err(CallError::WrongNonce);
    }
    if tx.to != spec.token {
        return Err(CallError::WrongToken);
    }
    if tx.value.0 != 0 {
        return Err(CallError::UnexpectedValue);
    }
    let expected = erc20_transfer(&spec.to, spec.amount);
    if tx.data != expected {
        if tx.data.len() < 4 || tx.data[..4] != selector("transfer(address,uint256)") {
            return Err(CallError::NotATransfer);
        }
        return Err(CallError::WrongAmount);
    }
    Ok(())
}

/// Builds the constrained payout transaction from a reservation spec and
/// operator fee params. The fee fields never move funds.
pub fn build_payout_tx(
    config: &ForeignConfig,
    spec: &PayoutSpec,
    max_priority_fee_per_gas: u128,
    max_fee_per_gas: u128,
    gas_limit: u64,
) -> Result<EvmTx, CallError> {
    if spec.amount == 0 {
        return Err(CallError::ZeroAmount);
    }
    let tx = EvmTx {
        chain_id: config.chain_id,
        nonce: spec.nonce,
        max_priority_fee_per_gas: U128(max_priority_fee_per_gas),
        max_fee_per_gas: U128(max_fee_per_gas),
        gas_limit,
        to: spec.token,
        value: U128(0),
        data: erc20_transfer(&spec.to, spec.amount),
    };
    verify_payout_tx(config, spec, &tx)?;
    Ok(tx)
}

// ─── Signing requests ────────────────────────────────────────────────────

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignStatus {
    /// Sent to the signer, no answer yet.
    Pending,
    /// The signature arrived and the signed transaction is stored.
    Signed,
    /// The signer failed or answered with something unusable; it can be retried.
    Failed,
}

/// A payout transaction waiting for, or holding, its MPC signature.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct SignRequest {
    pub payout_id: u64,
    /// Derivation path: every payout signs from its own foreign-chain address.
    pub path: String,
    pub tx: EvmTx,
    pub status: SignStatus,
    pub signed_tx: Option<Vec<u8>>,
    pub attempts: u32,
}

// ─── Signature response parsing ──────────────────────────────────────────

fn string_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    match value {
        Value::String(text) => Some(text),
        Value::Object(map) => keys
            .iter()
            .find_map(|key| map.get(*key))
            .and_then(|inner| string_field(inner, keys)),
        _ => None,
    }
}

fn to_array_32(bytes: Vec<u8>) -> Option<[u8; 32]> {
    bytes.try_into().ok()
}

/// Parses the signer's answer: `{"Secp256k1": {"big_r": ..., "s": ..., "recovery_id": n}}`
/// (also accepted without the outer tag).
pub fn parse_signature(response: &Value) -> Result<EcdsaSignature, MpcError> {
    let body = response
        .get("Secp256k1")
        .or_else(|| response.get("Ecdsa"))
        .unwrap_or(response);
    let big_r =
        string_field(&body["big_r"], &["affine_point", "point"]).ok_or(MpcError::BadSignature)?;
    let s = string_field(&body["s"], &["scalar"]).ok_or(MpcError::BadSignature)?;
    let recovery_id = body["recovery_id"].as_u64().ok_or(MpcError::BadSignature)?;
    if recovery_id > 1 {
        return Err(MpcError::BadSignature);
    }

    let point = hex_decode(big_r).ok_or(MpcError::BadSignature)?;
    let r = match point.len() {
        32 => to_array_32(point),
        33 | 65 => to_array_32(point[1..33].to_vec()),
        _ => None,
    }
    .ok_or(MpcError::BadSignature)?;
    let s =
        to_array_32(hex_decode(s).ok_or(MpcError::BadSignature)?).ok_or(MpcError::BadSignature)?;
    let n = U256::from_big_endian(&SECP256K1_N);
    for scalar in [&r, &s] {
        let value = U256::from_big_endian(scalar);
        if value.is_zero() || value >= n {
            return Err(MpcError::BadSignature);
        }
    }
    Ok(normalize_low_s(EcdsaSignature {
        r,
        s,
        y_parity: recovery_id as u8,
    }))
}

/// EVM nodes reject high-`s` signatures; flipping `s` to `n - s` also flips the parity.
pub fn normalize_low_s(signature: EcdsaSignature) -> EcdsaSignature {
    let n = U256::from_big_endian(&SECP256K1_N);
    let s = U256::from_big_endian(&signature.s);
    if s <= n >> 1 {
        return signature;
    }
    let flipped = (n - s).to_big_endian();
    EcdsaSignature {
        r: signature.r,
        s: flipped,
        y_parity: signature.y_parity ^ 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::json;

    fn addr(text: &str) -> [u8; 20] {
        parse_address(text).unwrap()
    }

    #[test]
    fn rlp_matches_the_specification_examples() {
        assert_eq!(rlp_bytes(b""), vec![0x80]);
        assert_eq!(rlp_bytes(b"dog"), vec![0x83, b'd', b'o', b'g']);
        assert_eq!(
            rlp_list(&[rlp_bytes(b"cat"), rlp_bytes(b"dog")]),
            vec![0xc8, 0x83, b'c', b'a', b't', 0x83, b'd', b'o', b'g']
        );
        assert_eq!(rlp_list(&[]), vec![0xc0]);
        assert_eq!(rlp_u128(0), vec![0x80]);
        assert_eq!(rlp_u128(15), vec![0x0f]);
        assert_eq!(rlp_u128(1024), vec![0x82, 0x04, 0x00]);
    }

    #[test]
    fn selectors_match_the_well_known_values() {
        assert_eq!(
            selector("transfer(address,uint256)"),
            [0xa9, 0x05, 0x9c, 0xbb]
        );
    }

    #[test]
    fn transfer_calldata_layout() {
        let dead = addr("000000000000000000000000000000000000dEaD");
        let data = erc20_transfer(&dead, 1_000_000);
        assert_eq!(data.len(), 4 + 64);
        assert_eq!(&data[..4], &[0xa9, 0x05, 0x9c, 0xbb]);
        assert_eq!(&data[4 + 12..4 + 32], &dead);
        assert_eq!(&data[4 + 32 + 16..], &1_000_000u128.to_be_bytes());
    }

    #[test]
    fn addresses_parse_with_and_without_prefix() {
        let text = "2626664c2603336E57B271c5C0b26F421741e481";
        assert_eq!(parse_address(text), parse_address(&format!("0x{text}")));
        assert!(parse_address("0x1234").is_err());
        assert!(parse_address("").is_err());
    }

    fn sample_tx() -> EvmTx {
        EvmTx {
            chain_id: 46630,
            nonce: 7,
            max_priority_fee_per_gas: U128(1_000_000),
            max_fee_per_gas: U128(2_000_000_000),
            gas_limit: 120_000,
            to: addr("2626664c2603336e57b271c5c0b26f421741e481"),
            value: U128(0),
            data: erc20_transfer(&addr("000000000000000000000000000000000000dead"), 1_000_000),
        }
    }

    #[test]
    fn the_signing_hash_is_the_keccak_of_the_unsigned_bytes() {
        let tx = sample_tx();
        assert_eq!(tx.signing_hash(), keccak(&tx.unsigned()));
        assert_eq!(
            hex_encode(&keccak(b"")),
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
    }

    #[test]
    fn changing_any_field_changes_the_hash() {
        let base = sample_tx().signing_hash();
        let mut tx = sample_tx();
        tx.nonce += 1;
        assert_ne!(tx.signing_hash(), base);
        let mut tx = sample_tx();
        tx.data[5] ^= 1;
        assert_ne!(tx.signing_hash(), base);
    }

    #[test]
    fn parses_the_signer_response_with_a_compressed_point() {
        let response = json!({
            "Secp256k1": {
                "big_r": format!("02{}", "ab".repeat(32)),
                "s": "11".repeat(32),
                "recovery_id": 0,
            }
        });
        let signature = parse_signature(&response).unwrap();
        assert_eq!(signature.r, [0xab; 32]);
        assert_eq!(signature.s, [0x11; 32]);
        assert_eq!(signature.y_parity, 0);
    }

    #[test]
    fn rejects_malformed_signer_responses() {
        for response in [
            json!({}),
            json!("nope"),
            json!({ "Secp256k1": { "big_r": "zz", "s": "00", "recovery_id": 0 } }),
            json!({ "big_r": "ab".repeat(31), "s": "11".repeat(32), "recovery_id": 0 }),
            json!({ "big_r": "02".to_string() + &"ab".repeat(32), "s": "11".repeat(31), "recovery_id": 0 }),
            json!({ "big_r": "02".to_string() + &"ab".repeat(32), "s": "11".repeat(32), "recovery_id": 2 }),
            json!({ "Ed25519": { "signature": [1, 2, 3] } }),
        ] {
            assert_eq!(
                parse_signature(&response),
                Err(MpcError::BadSignature),
                "{response}"
            );
        }
    }

    // ── reservation-bound verification ──

    const TOKEN: &str = "833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const RECIPIENT: &str = "00000000000000000000000000000000000a11ce";

    fn config() -> ForeignConfig {
        ForeignConfig {
            mpc_contract: "signer.testnet".parse().unwrap(),
            chain_id: 46630,
        }
    }

    fn spec() -> PayoutSpec {
        PayoutSpec {
            token: addr(TOKEN),
            to: addr(RECIPIENT),
            amount: 1_000_000,
            nonce: 7,
            chain_id: 46630,
        }
    }

    fn base_tx() -> EvmTx {
        EvmTx {
            chain_id: 46630,
            nonce: 7,
            max_priority_fee_per_gas: U128(1_000_000),
            max_fee_per_gas: U128(2_000_000_000),
            gas_limit: 120_000,
            to: addr(TOKEN),
            value: U128(0),
            data: erc20_transfer(&addr(RECIPIENT), 1_000_000),
        }
    }

    #[test]
    fn the_constrained_transaction_passes_verification() {
        let built = build_payout_tx(&config(), &spec(), 1_000_000, 2_000_000_000, 120_000).unwrap();
        assert_eq!(built, base_tx());
        assert_eq!(verify_payout_tx(&config(), &spec(), &built), Ok(()));
    }

    #[test]
    fn a_tampered_recipient_is_rejected() {
        let mut tampered = base_tx();
        tampered.data =
            erc20_transfer(&addr("00000000000000000000000000000000000bad01"), 1_000_000);
        assert_eq!(
            verify_payout_tx(&config(), &spec(), &tampered),
            Err(CallError::WrongAmount)
        );
    }

    #[test]
    fn a_tampered_amount_is_rejected() {
        let mut tampered = base_tx();
        tampered.data = erc20_transfer(&addr(RECIPIENT), 999_999);
        assert_eq!(
            verify_payout_tx(&config(), &spec(), &tampered),
            Err(CallError::WrongAmount)
        );
    }

    #[test]
    fn a_different_token_or_nonce_or_chain_is_rejected() {
        let mut tx = base_tx();
        tx.to = addr("4200000000000000000000000000000000000006");
        assert_eq!(
            verify_payout_tx(&config(), &spec(), &tx),
            Err(CallError::WrongToken)
        );
        let mut tx = base_tx();
        tx.nonce = 8;
        assert_eq!(
            verify_payout_tx(&config(), &spec(), &tx),
            Err(CallError::WrongNonce)
        );
        let mut tx = base_tx();
        tx.chain_id = 8453;
        assert_eq!(
            verify_payout_tx(&config(), &spec(), &tx),
            Err(CallError::WrongChain)
        );
        let mut tx = base_tx();
        tx.value = U128(1);
        assert_eq!(
            verify_payout_tx(&config(), &spec(), &tx),
            Err(CallError::UnexpectedValue)
        );
    }

    #[test]
    fn a_non_transfer_calldata_is_rejected() {
        let mut tx = base_tx();
        tx.data = vec![0xde, 0xad, 0xbe, 0xef];
        assert_eq!(
            verify_payout_tx(&config(), &spec(), &tx),
            Err(CallError::NotATransfer)
        );
    }

    #[test]
    fn zero_amount_is_refused() {
        let spec = PayoutSpec {
            amount: 0,
            ..spec()
        };
        assert_eq!(
            build_payout_tx(&config(), &spec, 1, 2, 3),
            Err(CallError::ZeroAmount)
        );
    }

    #[test]
    fn infrastructure_cannot_request_arbitrary_spending() {
        // A relayer cannot turn a reservation into a swap or approve call:
        // any calldata that is not the exact transfer fails.
        let mut tx = base_tx();
        tx.data = erc20_transfer(&addr(RECIPIENT), 1_000_000);
        tx.data[0] = 0x09; // approve selector
        assert_ne!(verify_payout_tx(&config(), &spec(), &tx), Ok(()));
    }

    #[test]
    fn a_high_s_signature_is_flipped_with_its_parity() {
        let n = U256::from_big_endian(&SECP256K1_N);
        let high = (n - U256::from(5u64)).to_big_endian();
        let normalized = normalize_low_s(EcdsaSignature {
            r: [1; 32],
            s: high,
            y_parity: 0,
        });
        let mut five = [0u8; 32];
        five[31] = 5;
        assert_eq!(normalized.s, five);
        assert_eq!(normalized.y_parity, 1);
    }
}
