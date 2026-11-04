import { keccak_256 } from "@noble/hashes/sha3.js";

/** Lowercase 0x-prefixed hex of bytes. */
export function toHex(bytes: Uint8Array): string {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Bytes of a hex string with or without `0x`. Throws on odd length or non-hex. */
export function fromHex(text: string): Uint8Array {
  const body = text.startsWith("0x") || text.startsWith("0X") ? text.slice(2) : text;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) throw new Error("invalid hex string");
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function keccak(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

export function keccakHex(text: string): string {
  return toHex(keccak(new TextEncoder().encode(text)));
}

/** First four bytes of the hash of a canonical function signature, as `0x` + 8 hex digits. */
export function selector(signature: string): string {
  return keccakHex(signature).slice(0, 10);
}

/** Normalized form of a 20-byte address: lowercase, `0x`-prefixed. Throws if malformed. */
export function normalizeAddress(text: string): string {
  const body = text.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{40}$/.test(body)) throw new Error("not a 20-byte hex address");
  return `0x${body.toLowerCase()}`;
}

export function isAddress(text: string): boolean {
  try {
    normalizeAddress(text);
    return true;
  } catch {
    return false;
  }
}

const U256_MAX = (1n << 256n) - 1n;

function wordUint(value: bigint): string {
  if (value < 0n || value > U256_MAX) throw new Error("value does not fit in uint256");
  return value.toString(16).padStart(64, "0");
}

function wordAddress(address: string): string {
  return normalizeAddress(address).slice(2).padStart(64, "0");
}

export const SEL_TRANSFER = selector("transfer(address,uint256)");
export const SEL_APPROVE = selector("approve(address,uint256)");
export const SEL_BALANCE_OF = selector("balanceOf(address)");
export const SEL_ALLOWANCE = selector("allowance(address,address)");
export const SEL_EXACT_INPUT_SINGLE = selector(
  "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
);
export const SEL_QUOTE_EXACT_INPUT_SINGLE = selector(
  "quoteExactInputSingle((address,address,uint256,uint24,uint160))",
);
/** topic0 of the ERC-20 `Transfer(address,address,uint256)` event. */
export const TRANSFER_TOPIC = keccakHex("Transfer(address,address,uint256)");

export const encodeBalanceOf = (owner: string): string => `${SEL_BALANCE_OF}${wordAddress(owner)}`;

export const encodeAllowance = (owner: string, spender: string): string =>
  `${SEL_ALLOWANCE}${wordAddress(owner)}${wordAddress(spender)}`;

export const encodeApprove = (spender: string, amount: bigint): string =>
  `${SEL_APPROVE}${wordAddress(spender)}${wordUint(amount)}`;

export const encodeTransfer = (to: string, amount: bigint): string =>
  `${SEL_TRANSFER}${wordAddress(to)}${wordUint(amount)}`;

/** SwapRouter02 `exactInputSingle` calldata with no price limit; mirrors the arena contract. */
export function encodeExactInputSingle(p: {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  recipient: string;
  amountIn: bigint;
  minOut: bigint;
}): string {
  return (
    SEL_EXACT_INPUT_SINGLE +
    wordAddress(p.tokenIn) +
    wordAddress(p.tokenOut) +
    wordUint(BigInt(p.fee)) +
    wordAddress(p.recipient) +
    wordUint(p.amountIn) +
    wordUint(p.minOut) +
    wordUint(0n)
  );
}

/** QuoterV2 `quoteExactInputSingle` calldata with no price limit. */
export function encodeQuoteExactInputSingle(p: {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: bigint;
}): string {
  return (
    SEL_QUOTE_EXACT_INPUT_SINGLE +
    wordAddress(p.tokenIn) +
    wordAddress(p.tokenOut) +
    wordUint(p.amountIn) +
    wordUint(BigInt(p.fee)) +
    wordUint(0n)
  );
}

/** First 32-byte word of an `eth_call` result as an unsigned integer. */
export function decodeUintWord(result: string, index = 0): bigint {
  const body = result.replace(/^0x/i, "");
  const word = body.slice(index * 64, index * 64 + 64);
  if (word.length !== 64) throw new Error("eth_call result is too short");
  return BigInt(`0x${word}`);
}
