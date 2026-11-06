import { normalizeAddress, TRANSFER_TOPIC } from "./evm-abi.js";

/** Receipt evidence for an authorized testnet verifier, not a trustless bridge proof.
 * Source-owner/NEAR-beneficiary authorization and receipt consumption belong to
 * the custody contract; a Transfer event alone MUST NOT authorize minting. */
export interface ReceiptRpc { request(method: string, params: unknown[]): Promise<unknown> }
export interface TransferRequest {
  transactionHash: string; token: string; sender: string; custody: string;
  maxReceived: bigint; confirmations: bigint;
}
export type TransferEvidence =
  | { status: "Pending"; reason: string }
  | { status: "Rejected"; reason: string }
  | { status: "Verified"; chainId: "46630"; transactionHash: string; blockHash: string;
      blockNumber: bigint; token: string; sender: string; custody: string;
      received: bigint; receiptIds: readonly string[]; trustModel: "authorized-verifier" };

const hash = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
function quantity(v: unknown): bigint {
  if (typeof v !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(v)) throw new Error("invalid RPC quantity");
  return BigInt(v);
}
function object(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("invalid RPC object");
  return v as Record<string, unknown>;
}
function topicAddress(v: unknown): string {
  if (typeof v !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(v)) throw new Error("invalid address topic");
  return "0x" + v.slice(-40).toLowerCase();
}

export async function verifyRobinhoodTransfer(rpc: ReceiptRpc, request: TransferRequest): Promise<TransferEvidence> {
  if (!hash(request.transactionHash) || request.maxReceived <= 0n || request.confirmations < 1n) throw new Error("invalid transfer verification request");
  const token = normalizeAddress(request.token), sender = normalizeAddress(request.sender), custody = normalizeAddress(request.custody);
  if (sender === custody) throw new Error("self-transfer cannot fund custody");
  const txHash = request.transactionHash.toLowerCase();
  try {
    if (quantity(await rpc.request("eth_chainId", [])) !== 46630n) return { status: "Rejected", reason: "wrong Robinhood testnet chain" };
    const raw = await rpc.request("eth_getTransactionReceipt", [txHash]);
    if (raw === null) return { status: "Pending", reason: "receipt not mined" };
    const receipt = object(raw);
    if (!hash(receipt.transactionHash) || receipt.transactionHash.toLowerCase() !== txHash) return { status: "Rejected", reason: "receipt transaction mismatch" };
    if (quantity(receipt.status) !== 1n) return { status: "Rejected", reason: "transaction reverted" };
    const blockNumber = quantity(receipt.blockNumber);
    if (!hash(receipt.blockHash)) throw new Error("missing receipt block hash");
    const blockHash = receipt.blockHash.toLowerCase();
    const latest = quantity(await rpc.request("eth_blockNumber", []));
    if (latest < blockNumber || latest - blockNumber + 1n < request.confirmations) return { status: "Pending", reason: "insufficient confirmations" };
    const canonical = await rpc.request("eth_getBlockByNumber", [receipt.blockNumber, false]);
    if (canonical === null) return { status: "Pending", reason: "canonical block unavailable" };
    const block = object(canonical);
    if (!hash(block.hash) || block.hash.toLowerCase() !== blockHash || quantity(block.number) !== blockNumber) return { status: "Pending", reason: "receipt block is not canonical" };
    if (!Array.isArray(receipt.logs)) throw new Error("missing receipt logs");
    let received = 0n;
    const ids: string[] = [], seen = new Set<string>();
    for (const rawLog of receipt.logs) {
      const log = object(rawLog);
      if (typeof log.address !== "string" || log.address.toLowerCase() !== token) continue;
      if (!Array.isArray(log.topics) || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
      if (log.topics.length !== 3) throw new Error("unexpected Transfer event shape");
      const from = topicAddress(log.topics[1]), to = topicAddress(log.topics[2]);
      if (to !== custody && from !== custody) continue;
      if (log.removed === true || !hash(log.blockHash) || log.blockHash.toLowerCase() !== blockHash || !hash(log.transactionHash) || log.transactionHash.toLowerCase() !== txHash || quantity(log.blockNumber) !== blockNumber) throw new Error("unbound custody log");
      if (to !== custody || from !== sender) return { status: "Rejected", reason: "ambiguous custody movement" };
      if (!hash(log.data)) throw new Error("invalid transfer amount encoding");
      const index = quantity(log.logIndex).toString();
      if (seen.has(index)) throw new Error("duplicate log index");
      seen.add(index); ids.push(`46630:${txHash}:${index}`); received += BigInt(log.data);
    }
    if (received <= 0n || received > request.maxReceived) return { status: "Rejected", reason: "unexpected custody receipt amount" };
    return { status: "Verified", chainId: "46630", transactionHash: txHash, blockHash, blockNumber, token, sender, custody, received, receiptIds: Object.freeze(ids), trustModel: "authorized-verifier" };
  } catch {
    // Provider errors may include RPC credentials; never surface their raw text.
    return { status: "Pending", reason: "receipt evidence unavailable or malformed" };
  }
}

/** Injectable, credential-redacting JSON-RPC transport for the authorized verifier. */
export class RobinhoodJsonRpc implements ReceiptRpc {
  #id = 0;
  constructor(private readonly url: string, private readonly fetcher: typeof fetch = fetch) {
    const endpoint = new URL(url);
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) {
      throw new Error("receipt RPC requires HTTPS outside loopback");
    }
  }
  async request(method: string, params: unknown[]): Promise<unknown> {
    const id = ++this.#id;
    try {
      const response = await this.fetcher(this.url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("RPC HTTP error");
      const body = object(await response.json());
      if (body.jsonrpc !== "2.0" || body.id !== id || body.error || !Object.hasOwn(body, "result")) throw new Error("invalid RPC envelope");
      return body.result;
    } catch { throw new Error("receipt RPC request failed"); }
  }
}
