//! Building and signing transactions for an EVM chain through NEAR Chain Signatures.
//!
//! This module is pure: it encodes EIP-1559 transactions and ABI calldata, hashes them for
//! the MPC signer, and assembles the signed transaction from the signature the signer
//! returns. The contract methods that call the signer live in `lib.rs`.

use crate::math::wide::U256;
use near_sdk::env;
use near_sdk::serde_json::Value;

/// A 20-byte EVM address.
pub type Address = [u8; 20];

/// secp256k1 group order.
const SECP256K1_N: [u8; 32] = [
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE,
    0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B, 0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36, 0x41, 0x41,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MpcError {
    /// Not a 20-byte hex address.
    BadAddress,
    /// The signer's answer is not a secp256k1 signature we understand.
    BadSignature,
}

// ─── RLP ────────────────────────────────────────────────────────────────

fn length_prefix(len: usize, short_offset: u8) -> Vec<u8> {
    if len < 56 {
        return vec![short_offset + len as u8];
    }
    let bytes = (len as u64).to_be_bytes();
    let skip = bytes.iter().take_while(|b| **b == 0).count();
    let mut out = vec![short_offset + 55 + (8 - skip) as u8];
    out.extend_from_slice(&bytes[skip..]);
    out
}

/// RLP encoding of a byte string.
pub fn rlp_bytes(data: &[u8]) -> Vec<u8> {
    if data.len() == 1 && data[0] < 0x80 {
        return data.to_vec();
    }
    let mut out = length_prefix(data.len(), 0x80);
    out.extend_from_slice(data);
    out
}

/// RLP encoding of an unsigned integer given as big-endian bytes (leading zeros dropped).
pub fn rlp_uint_bytes(be: &[u8]) -> Vec<u8> {
    let skip = be.iter().take_while(|b| **b == 0).count();
    rlp_bytes(&be[skip..])
}

pub fn rlp_u128(value: u128) -> Vec<u8> {
    rlp_uint_bytes(&value.to_be_bytes())
}

/// RLP encoding of a list whose items are already encoded.
pub fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = items.iter().flatten().copied().collect();
    let mut out = length_prefix(payload.len(), 0xc0);
    out.extend_from_slice(&payload);
    out
}

// ─── ABI ────────────────────────────────────────────────────────────────

pub fn keccak(data: &[u8]) -> [u8; 32] {
    env::keccak256_array(data)
}

/// First four bytes of the hash of a canonical function signature.
pub fn selector(signature: &str) -> [u8; 4] {
    let hash = keccak(signature.as_bytes());
    [hash[0], hash[1], hash[2], hash[3]]
}

fn word_address(address: &Address) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(address);
    word
}

fn word_u128(value: u128) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}

fn word_u32(value: u32) -> [u8; 32] {
    word_u128(value as u128)
}

/// `transfer(address,uint256)` calldata.
pub fn erc20_transfer(to: &Address, amount: u128) -> Vec<u8> {
    let mut data = selector("transfer(address,uint256)").to_vec();
    data.extend_from_slice(&word_address(to));
    data.extend_from_slice(&word_u128(amount));
    data
}

/// `approve(address,uint256)` calldata.
pub fn erc20_approve(spender: &Address, amount: u128) -> Vec<u8> {
    let mut data = selector("approve(address,uint256)").to_vec();
    data.extend_from_slice(&word_address(spender));
    data.extend_from_slice(&word_u128(amount));
    data
}

/// Uniswap V3 `SwapRouter02.exactInputSingle` calldata (no price limit).
pub fn exact_input_single(
    token_in: &Address,
    token_out: &Address,
    fee: u32,
    recipient: &Address,
    amount_in: u128,
    min_out: u128,
) -> Vec<u8> {
    let mut data =
        selector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))")
            .to_vec();
    data.extend_from_slice(&word_address(token_in));
    data.extend_from_slice(&word_address(token_out));
    data.extend_from_slice(&word_u32(fee));
    data.extend_from_slice(&word_address(recipient));
    data.extend_from_slice(&word_u128(amount_in));
    data.extend_from_slice(&word_u128(min_out));
    data.extend_from_slice(&[0u8; 32]); // sqrtPriceLimitX96 = 0
    data
}

/// Parses a 40-character hex address, with or without `0x`.
pub fn parse_address(text: &str) -> Result<Address, MpcError> {
    let text = text.strip_prefix("0x").unwrap_or(text);
    let bytes = hex_decode(text).ok_or(MpcError::BadAddress)?;
    bytes.try_into().map_err(|_| MpcError::BadAddress)
}

// ─── hex ────────────────────────────────────────────────────────────────

pub fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

pub fn hex_decode(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    let nibble = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    text.as_bytes()
        .chunks(2)
        .map(|pair| Some(nibble(pair[0])? << 4 | nibble(pair[1])?))
        .collect()
}

// ─── transactions ───────────────────────────────────────────────────────

/// An EIP-1559 (type 2) transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmTx {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
    pub to: Address,
    pub value: u128,
    pub data: Vec<u8>,
}

/// An ECDSA signature in the form EVM transactions carry it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EcdsaSignature {
    pub r: [u8; 32],
    pub s: [u8; 32],
    pub y_parity: u8,
}

impl EvmTx {
    fn fields(&self) -> Vec<Vec<u8>> {
        vec![
            rlp_u128(self.chain_id as u128),
            rlp_u128(self.nonce as u128),
            rlp_u128(self.max_priority_fee_per_gas),
            rlp_u128(self.max_fee_per_gas),
            rlp_u128(self.gas_limit as u128),
            rlp_bytes(&self.to),
            rlp_u128(self.value),
            rlp_bytes(&self.data),
            rlp_list(&[]), // empty access list
        ]
    }

    /// `0x02 || rlp(fields)`: the bytes that get hashed for signing.
    pub fn unsigned(&self) -> Vec<u8> {
        let mut out = vec![0x02];
        out.extend_from_slice(&rlp_list(&self.fields()));
        out
    }

    /// The 32-byte digest the MPC signer must sign.
    pub fn signing_hash(&self) -> [u8; 32] {
        keccak(&self.unsigned())
    }

    /// `0x02 || rlp(fields, yParity, r, s)`: ready to broadcast.
    pub fn signed(&self, signature: &EcdsaSignature) -> Vec<u8> {
        let mut fields = self.fields();
        fields.push(rlp_u128(signature.y_parity as u128));
        fields.push(rlp_uint_bytes(&signature.r));
        fields.push(rlp_uint_bytes(&signature.s));
        let mut out = vec![0x02];
        out.extend_from_slice(&rlp_list(&fields));
        out
    }
}

/// The transaction hash of a signed transaction.
pub fn tx_hash(signed: &[u8]) -> [u8; 32] {
    keccak(signed)
}

// ─── signature handling ─────────────────────────────────────────────────

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

/// Parses the signer's answer. It is `{"Secp256k1": {"big_r": ..., "s": ..., "recovery_id": n}}`
/// (also accepted without the outer tag). `big_r` is a compressed or uncompressed curve point
/// whose x coordinate is `r`, or the bare 32-byte `r`.
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

    fn addr(text: &str) -> Address {
        parse_address(text).unwrap()
    }

    // ── RLP: the examples from the Ethereum specification ──

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
        assert_eq!(rlp_bytes(&[0x7f]), vec![0x7f]);
        assert_eq!(rlp_bytes(&[0x80]), vec![0x81, 0x80]);
    }

    #[test]
    fn rlp_long_strings_and_lists_use_the_long_form() {
        let text = b"Lorem ipsum dolor sit amet, consectetur adipisicing elit";
        assert_eq!(text.len(), 56);
        let encoded = rlp_bytes(text);
        assert_eq!(&encoded[..2], &[0xb8, 0x38]);
        assert_eq!(&encoded[2..], text);

        let list = rlp_list(std::slice::from_ref(&encoded));
        assert_eq!(&list[..2], &[0xf8, 0x3a]);

        let big = vec![7u8; 300];
        let encoded = rlp_bytes(&big);
        assert_eq!(&encoded[..3], &[0xb9, 0x01, 0x2c]);
    }

    #[test]
    fn leading_zeros_are_dropped_from_integers() {
        assert_eq!(rlp_uint_bytes(&[0, 0, 1, 0]), vec![0x82, 0x01, 0x00]);
        assert_eq!(rlp_uint_bytes(&[0, 0, 0]), vec![0x80]);
    }

    // ── ABI ──

    #[test]
    fn selectors_match_the_well_known_values() {
        assert_eq!(
            selector("transfer(address,uint256)"),
            [0xa9, 0x05, 0x9c, 0xbb]
        );
        assert_eq!(
            selector("approve(address,uint256)"),
            [0x09, 0x5e, 0xa7, 0xb3]
        );
        assert_eq!(
            selector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"),
            [0x04, 0xe4, 0x5a, 0xaf]
        );
    }

    #[test]
    fn transfer_calldata_layout() {
        let data = erc20_transfer(&addr("000000000000000000000000000000000000dEaD"), 1_000_000);
        assert_eq!(data.len(), 4 + 64);
        assert_eq!(&data[..4], &[0xa9, 0x05, 0x9c, 0xbb]);
        assert_eq!(
            &data[4 + 12..4 + 32],
            &addr("000000000000000000000000000000000000dEaD")
        );
        assert_eq!(&data[4 + 32 + 16..], &1_000_000u128.to_be_bytes());
    }

    #[test]
    fn approve_calldata_layout() {
        let data = erc20_approve(&[0xAB; 20], u128::MAX);
        assert_eq!(&data[..4], &[0x09, 0x5e, 0xa7, 0xb3]);
        assert_eq!(&data[4 + 32 + 16..], &u128::MAX.to_be_bytes());
    }

    #[test]
    fn swap_calldata_layout() {
        let data = exact_input_single(&[1; 20], &[2; 20], 3000, &[3; 20], 500, 400);
        assert_eq!(data.len(), 4 + 7 * 32);
        assert_eq!(&data[..4], &[0x04, 0xe4, 0x5a, 0xaf]);
        assert_eq!(&data[4 + 12..4 + 32], &[1; 20]);
        assert_eq!(&data[4 + 32 + 12..4 + 64], &[2; 20]);
        assert_eq!(&data[4 + 64 + 29..4 + 96], &3000u32.to_be_bytes()[1..]);
        assert_eq!(&data[4 + 96 + 12..4 + 128], &[3; 20]);
        assert_eq!(&data[4 + 128 + 16..4 + 160], &500u128.to_be_bytes());
        assert_eq!(&data[4 + 160 + 16..4 + 192], &400u128.to_be_bytes());
        assert_eq!(&data[4 + 192..], &[0u8; 32]);
    }

    #[test]
    fn addresses_parse_with_and_without_prefix() {
        let text = "2626664c2603336E57B271c5C0b26F421741e481";
        assert_eq!(parse_address(text), parse_address(&format!("0x{text}")));
        assert!(parse_address("0x1234").is_err());
        assert!(parse_address(&"zz".repeat(20)).is_err());
        assert!(parse_address("").is_err());
    }

    #[test]
    fn hex_round_trips() {
        let bytes = [0u8, 1, 0xab, 0xff];
        assert_eq!(hex_encode(&bytes), "0001abff");
        assert_eq!(hex_decode("0001ABff"), Some(bytes.to_vec()));
        assert_eq!(hex_decode("abc"), None);
        assert_eq!(hex_decode("zz"), None);
    }

    // ── transactions: bytes cross-checked with an independent implementation ──

    fn sample_tx() -> EvmTx {
        EvmTx {
            chain_id: 8453,
            nonce: 7,
            max_priority_fee_per_gas: 1_000_000,
            max_fee_per_gas: 2_000_000_000,
            gas_limit: 120_000,
            to: addr("2626664c2603336e57b271c5c0b26f421741e481"),
            value: 0,
            data: erc20_transfer(&addr("000000000000000000000000000000000000dead"), 1_000_000),
        }
    }

    const UNSIGNED_VECTOR: &str = "02f86e82210507830f424084773594008301d4c0942626664c2603336e57b271c5c0b26f421741e48180b844a9059cbb000000000000000000000000000000000000000000000000000000000000dead00000000000000000000000000000000000000000000000000000000000f4240c0";
    const SIGNED_VECTOR: &str = "02f8b182210507830f424084773594008301d4c0942626664c2603336e57b271c5c0b26f421741e48180b844a9059cbb000000000000000000000000000000000000000000000000000000000000dead00000000000000000000000000000000000000000000000000000000000f4240c001a01111111111111111111111111111111111111111111111111111111111111111a02222222222222222222222222222222222222222222222222222222222222222";

    #[test]
    fn unsigned_transaction_matches_the_reference_bytes() {
        assert_eq!(hex_encode(&sample_tx().unsigned()), UNSIGNED_VECTOR);
    }

    #[test]
    fn signed_transaction_matches_the_reference_bytes() {
        let signature = EcdsaSignature {
            r: [0x11; 32],
            s: [0x22; 32],
            y_parity: 1,
        };
        assert_eq!(hex_encode(&sample_tx().signed(&signature)), SIGNED_VECTOR);
    }

    #[test]
    fn the_signing_hash_is_the_keccak_of_the_unsigned_bytes() {
        let tx = sample_tx();
        assert_eq!(tx.signing_hash(), keccak(&tx.unsigned()));
        // keccak256("") is a fixed, well-known constant
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
        let mut tx = sample_tx();
        tx.chain_id = 84532;
        assert_ne!(tx.signing_hash(), base);
    }

    #[test]
    fn building_twice_gives_identical_bytes() {
        assert_eq!(sample_tx().unsigned(), sample_tx().unsigned());
        assert_eq!(sample_tx().signing_hash(), sample_tx().signing_hash());
    }

    // ── signatures ──

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
    fn parses_nested_point_and_scalar_forms() {
        let response = json!({
            "big_r": { "affine_point": format!("03{}", "cd".repeat(32)) },
            "s": { "scalar": "22".repeat(32) },
            "recovery_id": 1,
        });
        let signature = parse_signature(&response).unwrap();
        assert_eq!(signature.r, [0xcd; 32]);
        assert_eq!(signature.s, [0x22; 32]);
        assert_eq!(signature.y_parity, 1);
    }

    #[test]
    fn parses_an_uncompressed_point_and_a_bare_r() {
        let uncompressed = json!({ "big_r": format!("04{}{}", "ef".repeat(32), "00".repeat(32)),
            "s": "01".repeat(32), "recovery_id": 0 });
        assert_eq!(parse_signature(&uncompressed).unwrap().r, [0xef; 32]);
        let bare = json!({ "big_r": "77".repeat(32), "s": "01".repeat(32), "recovery_id": 0 });
        assert_eq!(parse_signature(&bare).unwrap().r, [0x77; 32]);
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
            json!({ "big_r": "02".to_string() + &"ab".repeat(32), "s": "11".repeat(32) }),
            json!({ "Ed25519": { "signature": [1, 2, 3] } }),
        ] {
            assert_eq!(
                parse_signature(&response),
                Err(MpcError::BadSignature),
                "{response}"
            );
        }
    }

    #[test]
    fn a_low_s_signature_is_left_alone() {
        let signature = EcdsaSignature {
            r: [1; 32],
            s: [0x11; 32],
            y_parity: 0,
        };
        assert_eq!(normalize_low_s(signature), signature);
    }

    #[test]
    fn a_high_s_signature_is_flipped_with_its_parity() {
        let n = U256::from_big_endian(&SECP256K1_N);
        let high = (n - U256::from(5u64)).to_big_endian(); // n - 5 is above n / 2
        let normalized = normalize_low_s(EcdsaSignature {
            r: [1; 32],
            s: high,
            y_parity: 0,
        });
        let mut five = [0u8; 32];
        five[31] = 5;
        assert_eq!(normalized.s, five);
        assert_eq!(normalized.y_parity, 1);
        assert_eq!(normalized.r, [1; 32]);
    }

    #[test]
    fn s_exactly_half_the_order_is_already_low() {
        let n = U256::from_big_endian(&SECP256K1_N);
        let half = (n >> 1).to_big_endian();
        let signature = EcdsaSignature {
            r: [1; 32],
            s: half,
            y_parity: 1,
        };
        assert_eq!(normalize_low_s(signature), signature);
    }

    #[test]
    fn integers_with_leading_zero_bytes_encode_minimally_in_signed_transactions() {
        let mut r = [0u8; 32];
        r[31] = 9; // a very small r
        let signature = EcdsaSignature {
            r,
            s: [0x22; 32],
            y_parity: 0,
        };
        let signed = sample_tx().signed(&signature);
        // yParity 0 encodes as 0x80, r = 9 as the single byte 0x09, then s as 0xa0 + 32 bytes
        let tail = hex_encode(&signed[signed.len() - 35..]);
        assert!(tail.starts_with("8009a0"), "tail was {tail}");
    }
}
