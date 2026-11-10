import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Recomputes the arena's `valtrum-round-v1` commitment (contracts/arena/src/rounds.rs
 * `round_commitment`) from the exact detail of a `round_finalized` event, so the indexer can check
 * that the detail it stored is the detail the contract committed to. All integers are exact BigInt.
 */
export interface RoundScore {
  community: string;
  evidenceHash: string;
  negative: boolean;
  /** Decimal strings, up to 256 bits each. */
  numerator: string;
  denominator: string;
}

const enc = new TextEncoder();

function be(value: bigint, bytes: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(bytes * 8)) throw new Error("integer out of range");
  const out = new Uint8Array(bytes);
  let v = value;
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function str(text: string): Uint8Array {
  const body = enc.encode(text);
  return Uint8Array.from([...be(BigInt(body.length), 4), ...body]);
}

export function roundCommitmentHex(input: {
  battleId: string;
  roundId: string;
  startNs: string;
  endNs: string;
  policyHash: string;
  scores: RoundScore[];
}): string {
  const parts: Uint8Array[] = [
    str("valtrum-round-v1"),
    be(BigInt(input.battleId), 8),
    be(BigInt(input.roundId), 8),
    be(BigInt(input.startNs), 8),
    be(BigInt(input.endNs), 8),
    str(input.policyHash),
    be(BigInt(input.scores.length), 4),
  ];
  for (const s of input.scores) {
    parts.push(be(BigInt(s.community), 4), str(s.evidenceHash), Uint8Array.of(s.negative ? 1 : 0), be(BigInt(s.numerator), 32), be(BigInt(s.denominator), 32));
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return bytesToHex(sha256(all));
}
