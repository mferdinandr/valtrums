import { fromHex, keccak, toHex } from "./evm-abi.js";
import type { NearTransport } from "./near-client.js";

/** Resolves the EVM address that the MPC signer controls for a derivation path. */
export interface EvmAddressResolver {
  resolve(path: string): Promise<string>;
}

/** Derivation path of a battle; mirrors the arena contract. */
export const battlePath = (battleId: number): string => `valtrum-battle-${battleId}`;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin alphabet) decoding, keeping leading `1`s as zero bytes. */
export function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error("invalid base58 character");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  const zeros = text.length - text.replace(/^1+/, "").length;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

/**
 * EVM address of an uncompressed secp256k1 public key (64 bytes, x || y):
 * the last 20 bytes of keccak256(x || y).
 */
export function addressFromPublicKey(xy: Uint8Array): string {
  if (xy.length !== 64) throw new Error("expected a 64-byte uncompressed secp256k1 public key");
  return toHex(keccak(xy).slice(12));
}

/**
 * Address for a NEAR-format key string `secp256k1:<base58 of x||y>` as returned
 * by the signer's `derived_public_key` view. A 65-byte `04 || x || y` encoding
 * is accepted too. Compressed keys are rejected (they would need point decompression).
 */
export function addressFromNearKey(key: string): string {
  const prefix = "secp256k1:";
  if (!key.startsWith(prefix)) throw new Error("the signer returned a key that is not secp256k1");
  const bytes = base58Decode(key.slice(prefix.length));
  if (bytes.length === 65 && bytes[0] === 0x04) return addressFromPublicKey(bytes.slice(1));
  return addressFromPublicKey(bytes);
}

/** Address for a hex-encoded uncompressed public key, with or without `0x`/`04`. */
export function addressFromHexKey(hex: string): string {
  const bytes = fromHex(hex);
  return addressFromPublicKey(bytes.length === 65 && bytes[0] === 0x04 ? bytes.slice(1) : bytes);
}

/**
 * Asks the signer contract for the public key it derives for (arena account,
 * path) and converts it to an address. The key derivation itself happens in the
 * signer; nothing is derived locally, so it cannot drift from the real one.
 * Results are cached because a path always maps to the same key.
 */
export class SignerViewAddressResolver implements EvmAddressResolver {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly transport: Pick<NearTransport, "view">,
    /** The signer account, or a function that looks it up when first needed. */
    private readonly signerAccountId: string | (() => Promise<string>),
    /** The account that calls `sign` on the signer: the arena contract. */
    private readonly predecessor: string,
    private readonly domainId = 0,
  ) {}

  async resolve(path: string): Promise<string> {
    const cached = this.cache.get(path);
    if (cached) return cached;
    const signer = typeof this.signerAccountId === "string" ? this.signerAccountId : await this.signerAccountId();
    const key = await this.transport.view<string>(signer, "derived_public_key", {
      path,
      predecessor: this.predecessor,
      domain_id: this.domainId,
    });
    if (typeof key !== "string") throw new Error("the signer returned no derived public key");
    const address = addressFromNearKey(key);
    this.cache.set(path, address);
    return address;
  }
}

/** Fixed addresses per path, for tests. */
export class StaticAddressResolver implements EvmAddressResolver {
  constructor(private readonly byPath: (path: string) => string) {}
  async resolve(path: string): Promise<string> {
    return this.byPath(path);
  }
}
