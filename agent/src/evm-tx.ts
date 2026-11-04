import { fromHex, keccak, normalizeAddress, toHex } from "./evm-abi.js";

/** RLP value: a byte string or a list of values. */
export type Rlp = Uint8Array | Rlp[];

function lengthPrefix(len: number, shortOffset: number): number[] {
  if (len < 56) return [shortOffset + len];
  const bytes: number[] = [];
  for (let n = len; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return [shortOffset + 55 + bytes.length, ...bytes];
}

export function rlpEncode(value: Rlp): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length === 1 && (value[0] as number) < 0x80) return value;
    return Uint8Array.from([...lengthPrefix(value.length, 0x80), ...value]);
  }
  const payload = value.flatMap((v) => [...rlpEncode(v)]);
  return Uint8Array.from([...lengthPrefix(payload.length, 0xc0), ...payload]);
}

/** Decode exactly one RLP item; throws on malformed or trailing input. */
export function rlpDecode(data: Uint8Array): Rlp {
  const [item, end] = decodeAt(data, 0);
  if (end !== data.length) throw new Error("trailing bytes after RLP item");
  return item;
}

function readLen(data: Uint8Array, at: number, n: number): number {
  if (n > 4 || at + n > data.length) throw new Error("bad RLP length");
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + (data[at + i] as number);
  return len;
}

function decodeAt(data: Uint8Array, at: number): [Rlp, number] {
  const b = data[at];
  if (b === undefined) throw new Error("unexpected end of RLP");
  if (b < 0x80) return [data.slice(at, at + 1), at + 1];
  let start: number;
  let len: number;
  const isList = b >= 0xc0;
  const base = isList ? 0xc0 : 0x80;
  if (b <= base + 55) {
    start = at + 1;
    len = b - base;
  } else {
    const n = b - base - 55;
    len = readLen(data, at + 1, n);
    start = at + 1 + n;
  }
  const end = start + len;
  if (end > data.length) throw new Error("RLP item exceeds input");
  if (!isList) return [data.slice(start, end), end];
  const items: Rlp[] = [];
  for (let p = start; p < end; ) {
    const [item, next] = decodeAt(data, p);
    items.push(item);
    p = next;
  }
  return [items, end];
}

const toBig = (v: Rlp): bigint => {
  if (!(v instanceof Uint8Array)) throw new Error("expected an RLP byte string");
  return v.length === 0 ? 0n : BigInt(toHex(v));
};

export interface DecodedTx {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  /** Lowercase 0x address. */
  to: string;
  value: bigint;
  /** 0x-prefixed calldata. */
  data: string;
  /** True for a signed transaction (has yParity, r, s). */
  signed: boolean;
  r: Uint8Array | null;
}

/**
 * Decode an EIP-1559 (type 2) transaction, signed or unsigned, as the arena
 * stores it (`unsigned_tx` / `signed_tx` views, hex without 0x).
 */
export function decodeTx(hex: string): DecodedTx {
  const bytes = fromHex(hex);
  if (bytes[0] !== 0x02) throw new Error("not an EIP-1559 transaction");
  const list = rlpDecode(bytes.slice(1));
  if (!Array.isArray(list) || (list.length !== 9 && list.length !== 12)) {
    throw new Error("unexpected transaction field count");
  }
  const to = list[5];
  if (!(to instanceof Uint8Array) || to.length !== 20) throw new Error("transaction has no recipient");
  const data = list[7];
  if (!(data instanceof Uint8Array)) throw new Error("bad transaction data");
  return {
    chainId: toBig(list[0] as Rlp),
    nonce: toBig(list[1] as Rlp),
    maxPriorityFeePerGas: toBig(list[2] as Rlp),
    maxFeePerGas: toBig(list[3] as Rlp),
    gasLimit: toBig(list[4] as Rlp),
    to: normalizeAddress(toHex(to)),
    value: toBig(list[6] as Rlp),
    data: toHex(data),
    signed: list.length === 12,
    r: list.length === 12 ? (list[10] as Uint8Array) : null,
  };
}

/** Hash of a signed transaction: keccak256 of its bytes, `0x`-prefixed. */
export function txHash(signedHex: string): string {
  return toHex(keccak(fromHex(signedHex)));
}
