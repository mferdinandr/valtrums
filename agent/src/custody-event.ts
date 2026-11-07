import { fromHex, keccakHex, normalizeAddress } from "./evm-abi.js";

const DEPOSIT_TOPIC = keccakHex("Deposited(uint256,address,address,uint64,uint64,string,uint256,uint256)");
const U64_MAX = (1n << 64n) - 1n;

export interface CustodyLog { address: string; topics: string[]; data: string; removed?: boolean }
export interface CustodyDeposit {
  depositId: bigint; token: string; depositor: string; battleId: bigint;
  mappingVersion: bigint; beneficiary: string; requested: bigint; received: bigint;
}

/** Decode a single event from the expected custody contract. This does not
 * verify finality, token behavior, custody code, or authenticate an RPC. */
export function decodeCustodyDeposit(log: CustodyLog, custodyAddress: string): CustodyDeposit {
  if (log.removed || normalizeAddress(log.address) !== normalizeAddress(custodyAddress) || log.topics.length !== 4 || log.topics[0]?.toLowerCase() !== DEPOSIT_TOPIC) {
    throw new Error("wrong custody event source or topic");
  }
  const topicWord = (topic: string | undefined): string => {
    if (!topic || !/^0x[0-9a-f]{64}$/i.test(topic)) throw new Error("invalid event topic");
    return topic.slice(2).toLowerCase();
  };
  const addressTopic = (topic: string | undefined): string => {
    const word = topicWord(topic);
    if (!/^0{24}/.test(word)) throw new Error("invalid address topic");
    return normalizeAddress(word.slice(24));
  };
  const depositId = BigInt(`0x${topicWord(log.topics[1])}`);
  const token = addressTopic(log.topics[2]);
  const depositor = addressTopic(log.topics[3]);
  const body = fromHex(log.data);
  if (body.length < 192 || body.length % 32 !== 0) throw new Error("invalid deposit data length");
  const word = (index: number): bigint => BigInt(`0x${Array.from(body.slice(index * 32, (index + 1) * 32), (b) => b.toString(16).padStart(2, "0")).join("")}`);
  const battleId = word(0), mappingVersion = word(1), offset = word(2), requested = word(3), received = word(4);
  if (offset !== 160n || battleId > U64_MAX || mappingVersion === 0n || mappingVersion > U64_MAX || depositId === 0n || requested === 0n || received === 0n || received > requested) throw new Error("invalid deposit values");
  const length = word(5);
  if (length < 2n || length > 64n) throw new Error("invalid beneficiary length");
  const size = Number(length), padded = Math.ceil(size / 32) * 32;
  if (body.length !== 192 + padded || body.slice(192 + size).some((b) => b !== 0)) throw new Error("invalid beneficiary encoding");
  let beneficiary: string;
  try { beneficiary = new TextDecoder("utf-8", { fatal: true }).decode(body.slice(192, 192 + size)); }
  catch { throw new Error("invalid beneficiary encoding"); }
  return { depositId, token, depositor, battleId, mappingVersion, beneficiary, requested, received };
}
