import { TRANSFER_TOPIC, normalizeAddress } from "./evm-abi.js";
import type { EvmReceipt } from "./evm-rpc.js";

/** An indexed address topic is the address left-padded to 32 bytes. */
function topicAddress(topic: string | undefined): string | null {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return `0x${topic.slice(26).toLowerCase()}`;
}

/**
 * Total ERC-20 amount of `token` that `recipient` received in the receipt: the sum of
 * `Transfer(from, to, value)` logs emitted by `token` whose `to` is `recipient`.
 * Logs with another topic0, another emitter, or a different number of topics
 * (an ERC-721 Transfer has four) are ignored.
 */
export function receivedAmount(receipt: EvmReceipt, token: string, recipient: string): bigint {
  const tokenAddr = normalizeAddress(token);
  const to = normalizeAddress(recipient);
  let total = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== tokenAddr) continue;
    if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (topicAddress(log.topics[2]) !== to) continue;
    if (!/^0x[0-9a-fA-F]{64}$/.test(log.data)) throw new Error("malformed Transfer log data");
    total += BigInt(log.data);
  }
  return total;
}
