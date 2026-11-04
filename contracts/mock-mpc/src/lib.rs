//! A stand-in for the MPC signer, for sandbox and testnet use. It answers `sign` with a
//! deterministic, well-formed but NOT cryptographically valid secp256k1 signature, in the
//! same response shape as the real signer. Never use it where signatures matter.

use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, NearToken, PanicOnDefault};

#[near(serializers = [json])]
pub enum Payload {
    Ecdsa(String),
    Eddsa(String),
}

#[near(serializers = [json])]
pub struct SignInput {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockMpc {
    /// When set, `sign` panics, so callers can exercise their failure path.
    fail: bool,
    signed: u64,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[near]
impl MockMpc {
    #[init]
    pub fn new() -> Self {
        Self {
            fail: false,
            signed: 0,
        }
    }

    pub fn set_fail(&mut self, fail: bool) {
        self.fail = fail;
    }

    pub fn get_signed_count(&self) -> u64 {
        self.signed
    }

    /// Same shape as the real signer: arguments wrapped in `request`, 1 yoctoNEAR attached.
    #[payable]
    pub fn sign(&mut self, request: SignInput) -> Value {
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(1),
            "Requires at least 1 yoctoNEAR"
        );
        require!(!self.fail, "Mock signer is set to fail");
        let Payload::Ecdsa(payload) = &request.payload_v2 else {
            env::panic_str("Only ECDSA is supported by the mock");
        };
        require!(
            request.domain_id == 0,
            "Only domain 0 is supported by the mock"
        );
        self.signed += 1;

        let mut seed = payload.as_bytes().to_vec();
        seed.extend_from_slice(request.path.as_bytes());
        let mut r = env::keccak256_array(&seed);
        seed.push(1);
        let mut s = env::keccak256_array(&seed);
        // keep both scalars comfortably inside the valid range, and s below half the order
        r[0] &= 0x7f;
        s[0] &= 0x7f;
        r[31] |= 1;
        s[31] |= 1;
        json!({
            "Secp256k1": {
                "big_r": format!("02{}", hex(&r)),
                "s": hex(&s),
                "recovery_id": r[31] & 1,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(payload: &str, path: &str) -> SignInput {
        SignInput {
            path: path.into(),
            payload_v2: Payload::Ecdsa(payload.into()),
            domain_id: 0,
        }
    }

    fn with_deposit() {
        let ctx = near_sdk::test_utils::VMContextBuilder::new()
            .attached_deposit(NearToken::from_yoctonear(1))
            .build();
        near_sdk::testing_env!(ctx);
    }

    #[test]
    fn answers_in_the_real_signers_shape_and_deterministically() {
        with_deposit();
        let mut mpc = MockMpc::new();
        let first = mpc.sign(input("ab".repeat(32).as_str(), "valtrum-battle-1"));
        let second = mpc.sign(input("ab".repeat(32).as_str(), "valtrum-battle-1"));
        assert_eq!(first, second);
        let body = &first["Secp256k1"];
        assert_eq!(body["big_r"].as_str().unwrap().len(), 66);
        assert_eq!(body["s"].as_str().unwrap().len(), 64);
        assert!(body["recovery_id"].as_u64().unwrap() <= 1);
        assert_eq!(mpc.get_signed_count(), 2);
    }

    #[test]
    fn different_paths_or_payloads_give_different_signatures() {
        with_deposit();
        let mut mpc = MockMpc::new();
        let a = mpc.sign(input("aa", "valtrum-battle-1"));
        let b = mpc.sign(input("aa", "valtrum-battle-2"));
        let c = mpc.sign(input("bb", "valtrum-battle-1"));
        assert_ne!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    #[should_panic(expected = "Mock signer is set to fail")]
    fn can_be_told_to_fail() {
        with_deposit();
        let mut mpc = MockMpc::new();
        mpc.set_fail(true);
        mpc.sign(input("aa", "p"));
    }

    #[test]
    #[should_panic(expected = "Requires at least 1 yoctoNEAR")]
    fn requires_the_deposit() {
        near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
        let mut mpc = MockMpc::new();
        mpc.sign(input("aa", "p"));
    }
}
