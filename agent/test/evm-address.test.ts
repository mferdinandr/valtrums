import { describe, expect, it } from "vitest";
import { SignerViewAddressResolver, addressFromHexKey, addressFromNearKey, base58Decode, battlePath } from "../src/evm-address.js";

// Public key of the secp256k1 secret key 1 (the generator point G). The address is the
// widely published one for that key; the base58 string was produced by an independent encoder.
const G_X = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const G_Y = "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
const G_ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const G_BASE58 = "3SB8tA9Kbn7FBtT6GWR6AJk73QceudisHaGThPoLCDgC9tan7d3cwZFiDZtrmhSAf8aTynEdQ3N7KXhMm3nWhekP";

describe("evm address from public key", () => {
  it("derives the known address from hex and NEAR key forms", () => {
    expect(addressFromHexKey(G_X + G_Y)).toBe(G_ADDRESS);
    expect(addressFromHexKey(`04${G_X}${G_Y}`)).toBe(G_ADDRESS);
    expect(addressFromNearKey(`secp256k1:${G_BASE58}`)).toBe(G_ADDRESS);
  });

  it("decodes base58 including leading zeros", () => {
    expect(Array.from(base58Decode("11z"))).toEqual([0, 0, 57]);
    expect(() => base58Decode("0OIl")).toThrow("invalid base58");
  });

  it("rejects other key types and sizes", () => {
    expect(() => addressFromNearKey(`ed25519:${G_BASE58}`)).toThrow("not secp256k1");
    expect(() => addressFromNearKey("secp256k1:3SB8tA9K")).toThrow("64-byte");
  });
});

describe("SignerViewAddressResolver", () => {
  it("calls the view with path, predecessor and domain, and caches", async () => {
    const calls: Array<{ contract: string; method: string; args: object }> = [];
    const transport = {
      async view<T>(contract: string, method: string, args: object) {
        calls.push({ contract, method, args });
        return `secp256k1:${G_BASE58}` as T;
      },
    };
    const r = new SignerViewAddressResolver(transport, "signer.testnet", "arena.testnet");
    expect(await r.resolve(battlePath(7))).toBe(G_ADDRESS);
    expect(await r.resolve(battlePath(7))).toBe(G_ADDRESS);
    expect(calls).toEqual([
      {
        contract: "signer.testnet",
        method: "derived_public_key",
        args: { path: "valtrum-battle-7", predecessor: "arena.testnet", domain_id: 0 },
      },
    ]);
  });

  it("fails when the signer returns nothing", async () => {
    const r = new SignerViewAddressResolver({ view: async () => undefined }, "s", "a");
    await expect(r.resolve("p")).rejects.toThrow("no derived public key");
  });
});
