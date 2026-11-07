import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Reference-token mapping. GoPlus covers Robinhood mainnet (4663) only, so a testnet (46630)
 * mock token is audited through the mainnet token it represents. The mapping is accepted only
 * from this protocol-controlled registry; a mapping the token merely declares about itself is
 * never trusted. Approval attests the reference token, not the testnet mock contract.
 */

export const GOPLUS_REFERENCE_CHAIN_ID = "4663";

export interface ReferenceEntry {
  chainId: string;
  token: string;
  referenceChainId: string;
  referenceToken: string;
}

export interface ReferenceBinding {
  chainId: string;
  token: string;
  /** Digest of the registry entry that authorized this mapping. */
  registryEntryHash: string;
}

/** Metadata a mock token carries about itself (`reference_chain_id`, `reference_address`); untrusted. */
export interface DeclaredReference {
  referenceChainId: string;
  referenceAddress: string;
}

export type ReferenceResolution =
  | { kind: "direct" }
  | { kind: "mapped"; reference: ReferenceBinding }
  | { kind: "hold"; code: "reference_unregistered" | "reference_conflict"; message: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function entryHash(e: ReferenceEntry): string {
  return bytesToHex(
    sha256(
      utf8ToBytes(
        JSON.stringify([e.chainId, e.token.toLowerCase(), e.referenceChainId, e.referenceToken.toLowerCase()]),
      ),
    ),
  );
}

/** Validates registry entries; throws on malformed or inconsistent configuration. */
export function validateRegistry(entries: ReferenceEntry[]): ReferenceEntry[] {
  const seen = new Set<string>();
  for (const e of entries) {
    if (!/^[1-9][0-9]*$/.test(e.chainId) || !ADDRESS.test(e.token) || !ADDRESS.test(e.referenceToken)) {
      throw new Error("reference registry entry has a malformed chain id or address");
    }
    if (e.referenceChainId !== GOPLUS_REFERENCE_CHAIN_ID) {
      throw new Error(`reference registry entries must reference chain ${GOPLUS_REFERENCE_CHAIN_ID}`);
    }
    if (e.chainId === e.referenceChainId) {
      throw new Error("reference registry entry must map a different chain than its reference");
    }
    const key = `${e.chainId}:${e.token.toLowerCase()}`;
    if (seen.has(key)) throw new Error("reference registry has a duplicate token entry");
    seen.add(key);
  }
  return entries;
}

export function resolveReference(
  asset: { chainId: string; token: string },
  registry: readonly ReferenceEntry[],
  declared?: DeclaredReference | null,
): ReferenceResolution {
  const entry = registry.find((e) => e.chainId === asset.chainId && e.token.toLowerCase() === asset.token.toLowerCase());
  if (!entry) {
    if (declared) {
      return {
        kind: "hold",
        code: "reference_unregistered",
        message: "token declares a reference mapping that is not in the protocol registry",
      };
    }
    return { kind: "direct" };
  }
  if (
    declared &&
    (declared.referenceChainId !== entry.referenceChainId ||
      declared.referenceAddress.toLowerCase() !== entry.referenceToken.toLowerCase())
  ) {
    return {
      kind: "hold",
      code: "reference_conflict",
      message: "token metadata disagrees with the protocol registry reference mapping",
    };
  }
  return {
    kind: "mapped",
    reference: { chainId: entry.referenceChainId, token: entry.referenceToken, registryEntryHash: entryHash(entry) },
  };
}
