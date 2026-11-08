/** A log entry of a transaction receipt, in the shape of `eth_getTransactionReceipt`. */
export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  /** Index of the log within its block; absent in older fixtures. */
  logIndex?: number;
}

export interface EvmReceipt {
  transactionHash: string;
  /** True when the transaction succeeded, false when it reverted. */
  status: boolean;
  blockNumber: bigint;
  /** Hash of the block that includes the transaction; absent in older fixtures. */
  blockHash?: string;
  logs: EvmLog[];
}

export interface EvmFees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** The subset of an EVM JSON-RPC node the foreign-chain executor needs. Injectable for tests. */
export interface EvmRpc {
  chainId(): Promise<bigint>;
  blockNumber(): Promise<bigint>;
  getTransactionCount(address: string, tag: "pending" | "latest"): Promise<bigint>;
  getBalance(address: string): Promise<bigint>;
  getFees(): Promise<EvmFees>;
  estimateGas(tx: { from: string; to: string; data: string }): Promise<bigint>;
  /** `eth_call` at the latest block; returns the raw hex result. */
  call(tx: { to: string; data: string; from?: string }): Promise<string>;
  /** Broadcast a signed transaction; returns its hash. */
  sendRawTransaction(rawHex: string): Promise<string>;
  /** Null while the transaction is not mined. */
  getTransactionReceipt(hash: string): Promise<EvmReceipt | null>;
  /** True when the node knows the transaction (pending or mined). */
  isTransactionKnown(hash: string): Promise<boolean>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const big = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) throw new Error(`bad ${what} in RPC response`);
  return BigInt(v);
};

/**
 * JSON-RPC over `fetch`. Error messages name the method and the RPC error text
 * only: the URL may embed an API key and is never included.
 */
export class FetchEvmRpc implements EvmRpc {
  private id = 0;

  constructor(
    private readonly url: string,
    private readonly opts: { fetch?: FetchLike; timeoutMs?: number } = {},
  ) {}

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const doFetch: FetchLike = this.opts.fetch ?? ((u, i) => fetch(u, i));
    let res: Response;
    try {
      res = await doFetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new Error(`EVM RPC ${method} request failed: ${err instanceof Error ? err.name : "error"}`);
    }
    if (!res.ok) throw new Error(`EVM RPC ${method} failed with HTTP status ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
    if (body.error) throw new Error(`EVM RPC ${method} error: ${body.error.message ?? "unknown"}`);
    return body.result;
  }

  async chainId(): Promise<bigint> {
    return big(await this.rpc("eth_chainId", []), "chain id");
  }

  async blockNumber(): Promise<bigint> {
    return big(await this.rpc("eth_blockNumber", []), "block number");
  }

  /** Timestamp (seconds) of a block, from `eth_getBlockByNumber`. */
  async blockTimestamp(blockNumber: bigint): Promise<bigint> {
    const block = (await this.rpc("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false])) as {
      timestamp?: unknown;
    } | null;
    return big(block?.timestamp, "block timestamp");
  }

  async getTransactionCount(address: string, tag: "pending" | "latest" | "finalized"): Promise<bigint> {
    return big(await this.rpc("eth_getTransactionCount", [address, tag]), "nonce");
  }

  /** Number and hash of the newest finalized block (`eth_getBlockByNumber("finalized")`). */
  async getFinalizedBlock(): Promise<{ number: bigint; hash: string }> {
    const block = (await this.rpc("eth_getBlockByNumber", ["finalized", false])) as {
      number?: unknown;
      hash?: unknown;
    } | null;
    if (!block || typeof block.hash !== "string") throw new Error("no finalized block in RPC response");
    return { number: big(block.number, "finalized block number"), hash: block.hash };
  }

  /** Hash of the block at `number`, or null when the node has no such block. */
  async getBlockHash(number: bigint): Promise<string | null> {
    const block = (await this.rpc("eth_getBlockByNumber", [`0x${number.toString(16)}`, false])) as {
      hash?: unknown;
    } | null;
    return block && typeof block.hash === "string" ? block.hash : null;
  }

  async getBalance(address: string): Promise<bigint> {
    return big(await this.rpc("eth_getBalance", [address, "latest"]), "balance");
  }

  /** maxFee = 2 * next base fee + priority tip (the usual headroom for 6 full blocks). */
  async getFees(): Promise<EvmFees> {
    const history = (await this.rpc("eth_feeHistory", [1, "latest", []])) as {
      baseFeePerGas?: unknown[];
    };
    const bases = history?.baseFeePerGas;
    let baseFee: bigint;
    if (Array.isArray(bases) && bases.length > 0) {
      baseFee = big(bases[bases.length - 1], "base fee");
    } else {
      baseFee = big(await this.rpc("eth_gasPrice", []), "gas price");
    }
    let tip: bigint;
    try {
      tip = big(await this.rpc("eth_maxPriorityFeePerGas", []), "priority fee");
    } catch {
      tip = 1_000_000n; // 0.001 gwei fallback when the node lacks the method
    }
    return { maxFeePerGas: baseFee * 2n + tip, maxPriorityFeePerGas: tip };
  }

  async estimateGas(tx: { from: string; to: string; data: string }): Promise<bigint> {
    return big(await this.rpc("eth_estimateGas", [tx]), "gas estimate");
  }

  /** `eth_call` at `block` when given (so several reads share one block), else at the latest block. */
  async call(tx: { to: string; data: string; from?: string }, block?: bigint): Promise<string> {
    const result = await this.rpc("eth_call", [tx, block === undefined ? "latest" : `0x${block.toString(16)}`]);
    if (typeof result !== "string") throw new Error("bad eth_call result");
    return result;
  }

  async sendRawTransaction(rawHex: string): Promise<string> {
    const result = await this.rpc("eth_sendRawTransaction", [rawHex.startsWith("0x") ? rawHex : `0x${rawHex}`]);
    if (typeof result !== "string") throw new Error("bad transaction hash in RPC response");
    return result;
  }

  async getTransactionReceipt(hash: string): Promise<EvmReceipt | null> {
    const r = (await this.rpc("eth_getTransactionReceipt", [hash])) as {
      transactionHash: string;
      status: string;
      blockNumber: string;
      blockHash?: string;
      logs: Array<{ address: string; topics: string[]; data: string; logIndex?: string }>;
    } | null;
    if (!r) return null;
    return {
      transactionHash: r.transactionHash,
      status: big(r.status, "receipt status") === 1n,
      blockNumber: big(r.blockNumber, "receipt block"),
      ...(typeof r.blockHash === "string" ? { blockHash: r.blockHash } : {}),
      logs: (r.logs ?? []).map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        ...(typeof l.logIndex === "string" ? { logIndex: Number(big(l.logIndex, "log index")) } : {}),
      })),
    };
  }

  async isTransactionKnown(hash: string): Promise<boolean> {
    return (await this.rpc("eth_getTransactionByHash", [hash])) != null;
  }
}
