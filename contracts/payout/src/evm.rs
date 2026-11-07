//! Pure EIP-1559 transaction building and signer-response parsing for the payout
//! contract. It is reimplemented here (not linked from the arena crate) and is
//! checked against the same reference bytes as `agent/src/evm-tx.ts`.
//!
//! The payout contract builds exactly one kind of transaction: an ERC-20
//! `transfer(destination, amount)` on the registered token, with zero value and
//! an empty access list.
use near_sdk::env;
use near_sdk::serde_json::Value;

pub type Address = [u8; 20];

/// secp256k1 group order, big endian.
const SECP256K1_N: [u8; 32] = [
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE,
    0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B, 0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36, 0x41, 0x41,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignatureError {
    Malformed,
}

fn length_prefix(len: usize, short_offset: u8) -> Vec<u8> {
    if len < 56 {
        return vec![short_offset.saturating_add(len as u8)];
    }
    let bytes = (len as u64).to_be_bytes();
    let skip = bytes.iter().take_while(|b| **b == 0).count();
    let mut out = vec![short_offset
        .saturating_add(55)
        .saturating_add((8 - skip) as u8)];
    out.extend_from_slice(&bytes[skip..]);
    out
}

fn rlp_bytes(data: &[u8]) -> Vec<u8> {
    if data.len() == 1 && data[0] < 0x80 {
        return data.to_vec();
    }
    let mut out = length_prefix(data.len(), 0x80);
    out.extend_from_slice(data);
    out
}

fn rlp_uint_bytes(be: &[u8]) -> Vec<u8> {
    let skip = be.iter().take_while(|b| **b == 0).count();
    rlp_bytes(&be[skip..])
}

fn rlp_u128(value: u128) -> Vec<u8> {
    rlp_uint_bytes(&value.to_be_bytes())
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = items.iter().flatten().copied().collect();
    let mut out = length_prefix(payload.len(), 0xc0);
    out.extend_from_slice(&payload);
    out
}

pub fn keccak(data: &[u8]) -> [u8; 32] {
    env::keccak256_array(data)
}

/// `transfer(address,uint256)` calldata (selector `0xa9059cbb`).
pub fn erc20_transfer(to: &Address, amount: u128) -> Vec<u8> {
    let mut data = vec![0xa9, 0x05, 0x9c, 0xbb];
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(to);
    data.extend_from_slice(&word);
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&amount.to_be_bytes());
    data.extend_from_slice(&word);
    data
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EcdsaSignature {
    pub r: [u8; 32],
    pub s: [u8; 32],
    pub y_parity: u8,
}

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

impl EvmTx {
    fn fields(&self) -> Vec<Vec<u8>> {
        vec![
            rlp_u128(u128::from(self.chain_id)),
            rlp_u128(u128::from(self.nonce)),
            rlp_u128(self.max_priority_fee_per_gas),
            rlp_u128(self.max_fee_per_gas),
            rlp_u128(u128::from(self.gas_limit)),
            rlp_bytes(&self.to),
            rlp_u128(self.value),
            rlp_bytes(&self.data),
            rlp_list(&[]),
        ]
    }

    /// `0x02 || rlp(fields)`: the bytes hashed for signing.
    pub fn unsigned(&self) -> Vec<u8> {
        let mut out = vec![0x02];
        out.extend_from_slice(&rlp_list(&self.fields()));
        out
    }

    pub fn signing_hash(&self) -> [u8; 32] {
        keccak(&self.unsigned())
    }

    /// `0x02 || rlp(fields, yParity, r, s)`.
    pub fn signed(&self, signature: &EcdsaSignature) -> Vec<u8> {
        let mut fields = self.fields();
        fields.push(rlp_u128(u128::from(signature.y_parity)));
        fields.push(rlp_uint_bytes(&signature.r));
        fields.push(rlp_uint_bytes(&signature.s));
        let mut out = vec![0x02];
        out.extend_from_slice(&rlp_list(&fields));
        out
    }
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[usize::from(byte >> 4)] as char);
        out.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    out
}

fn hex_decode(text: &str) -> Option<Vec<u8>> {
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
        .map(|pair| Some((nibble(pair[0])? << 4) | nibble(pair[1])?))
        .collect()
}

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

fn array_32(bytes: Vec<u8>) -> Option<[u8; 32]> {
    bytes.try_into().ok()
}

/// Big-endian comparison of two 32-byte scalars.
fn below(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a < b
}

fn is_valid_scalar(value: &[u8; 32]) -> bool {
    value.iter().any(|b| *b != 0) && below(value, &SECP256K1_N)
}

/// `n - s` for `0 < s < n`, big endian.
fn order_minus(s: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut diff = i16::from(SECP256K1_N[i]) - i16::from(s[i]) - borrow;
        if diff < 0 {
            diff += 256;
            borrow = 1;
        } else {
            borrow = 0;
        }
        out[i] = diff as u8;
    }
    out
}

/// `n >> 1`, big endian.
fn half_order() -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut carry = 0u8;
    for i in 0..32 {
        out[i] = (SECP256K1_N[i] >> 1) | carry;
        carry = (SECP256K1_N[i] & 1) << 7;
    }
    out
}

/// EVM nodes reject high-`s`: flip to `n - s` and flip the parity.
pub fn normalize_low_s(signature: EcdsaSignature) -> EcdsaSignature {
    if signature.s <= half_order() {
        return signature;
    }
    EcdsaSignature {
        r: signature.r,
        s: order_minus(&signature.s),
        y_parity: signature.y_parity ^ 1,
    }
}

/// Parses the signer's answer: `{"Secp256k1": {"big_r": ..., "s": ..., "recovery_id": n}}`,
/// also without the outer tag, and with the nested `affine_point` / `scalar` forms.
pub fn parse_signature(response: &Value) -> Result<EcdsaSignature, SignatureError> {
    let bad = SignatureError::Malformed;
    let body = response
        .get("Secp256k1")
        .or_else(|| response.get("Ecdsa"))
        .unwrap_or(response);
    let big_r = string_field(&body["big_r"], &["affine_point", "point"]).ok_or(bad)?;
    let s = string_field(&body["s"], &["scalar"]).ok_or(bad)?;
    let recovery_id = body["recovery_id"].as_u64().ok_or(bad)?;
    if recovery_id > 1 {
        return Err(bad);
    }
    let point = hex_decode(big_r).ok_or(bad)?;
    let r = match point.len() {
        32 => array_32(point),
        33 | 65 => array_32(point[1..33].to_vec()),
        _ => None,
    }
    .ok_or(bad)?;
    let s = array_32(hex_decode(s).ok_or(bad)?).ok_or(bad)?;
    if !is_valid_scalar(&r) || !is_valid_scalar(&s) {
        return Err(bad);
    }
    Ok(normalize_low_s(EcdsaSignature {
        r,
        s,
        y_parity: recovery_id as u8,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::json;

    fn tx() -> EvmTx {
        EvmTx {
            chain_id: 8453,
            nonce: 7,
            max_priority_fee_per_gas: 1_000_000,
            max_fee_per_gas: 2_000_000_000,
            gas_limit: 120_000,
            to: [
                0x26, 0x26, 0x66, 0x4c, 0x26, 0x03, 0x33, 0x6e, 0x57, 0xb2, 0x71, 0xc5, 0xc0, 0xb2,
                0x6f, 0x42, 0x17, 0x41, 0xe4, 0x81,
            ],
            value: 0,
            data: erc20_transfer(
                &{
                    let mut a = [0u8; 20];
                    a[18] = 0xde;
                    a[19] = 0xad;
                    a
                },
                1_000_000,
            ),
        }
    }

    /// Same vectors as the arena crate and `agent/test/payout-evm.test.ts`.
    pub const UNSIGNED_VECTOR: &str = "02f86e82210507830f424084773594008301d4c0942626664c2603336e57b271c5c0b26f421741e48180b844a9059cbb000000000000000000000000000000000000000000000000000000000000dead00000000000000000000000000000000000000000000000000000000000f4240c0";
    pub const SIGNED_VECTOR: &str = "02f8b182210507830f424084773594008301d4c0942626664c2603336e57b271c5c0b26f421741e48180b844a9059cbb000000000000000000000000000000000000000000000000000000000000dead00000000000000000000000000000000000000000000000000000000000f4240c001a01111111111111111111111111111111111111111111111111111111111111111a02222222222222222222222222222222222222222222222222222222222222222";

    #[test]
    fn unsigned_and_signed_bytes_match_the_reference_vectors() {
        assert_eq!(hex_encode(&tx().unsigned()), UNSIGNED_VECTOR);
        let signature = EcdsaSignature {
            r: [0x11; 32],
            s: [0x22; 32],
            y_parity: 1,
        };
        assert_eq!(hex_encode(&tx().signed(&signature)), SIGNED_VECTOR);
        assert_eq!(tx().signing_hash(), keccak(&tx().unsigned()));
    }

    #[test]
    fn transfer_calldata_has_selector_recipient_and_amount() {
        let data = erc20_transfer(&[3; 20], 98);
        assert_eq!(data.len(), 68);
        assert_eq!(&data[..4], &[0xa9, 0x05, 0x9c, 0xbb]);
        assert_eq!(&data[16..36], &[3; 20]);
        assert_eq!(&data[52..], &98u128.to_be_bytes());
    }

    #[test]
    fn signer_responses_parse_in_every_known_shape() {
        let point = format!("02{}", "ab".repeat(32));
        let tagged = json!({"Secp256k1": {"big_r": point, "s": "11".repeat(32), "recovery_id": 0}});
        let parsed = parse_signature(&tagged).expect("tagged");
        assert_eq!(
            (parsed.r, parsed.s, parsed.y_parity),
            ([0xab; 32], [0x11; 32], 0)
        );
        let nested = json!({"big_r": {"affine_point": format!("03{}", "cd".repeat(32))},
            "s": {"scalar": "22".repeat(32)}, "recovery_id": 1});
        assert_eq!(parse_signature(&nested).expect("nested").r, [0xcd; 32]);
    }

    #[test]
    fn malformed_or_out_of_range_signatures_are_rejected() {
        let point = format!("02{}", "ab".repeat(32));
        let n_hex = hex_encode(&SECP256K1_N);
        for response in [
            json!({}),
            json!("nope"),
            json!({"big_r": point, "s": "11".repeat(31), "recovery_id": 0}),
            json!({"big_r": point, "s": "11".repeat(32), "recovery_id": 2}),
            json!({"big_r": point, "s": "11".repeat(32)}),
            json!({"big_r": point, "s": "00".repeat(32), "recovery_id": 0}),
            json!({"big_r": point, "s": n_hex, "recovery_id": 0}),
            json!({"big_r": format!("02{}", "00".repeat(32)), "s": "11".repeat(32), "recovery_id": 0}),
        ] {
            assert_eq!(parse_signature(&response), Err(SignatureError::Malformed));
        }
    }

    #[test]
    fn a_high_s_signature_is_flipped_with_its_parity() {
        let mut five = [0u8; 32];
        five[31] = 5;
        let high = order_minus(&five);
        let flipped = normalize_low_s(EcdsaSignature {
            r: [1; 32],
            s: high,
            y_parity: 0,
        });
        assert_eq!((flipped.s, flipped.y_parity), (five, 1));
        let low = EcdsaSignature {
            r: [1; 32],
            s: half_order(),
            y_parity: 1,
        };
        assert_eq!(normalize_low_s(low), low);
    }
}
