import { encodeBalanceOf, normalizeAddress } from "./evm-abi.js";
import type { FinalitySource, SourceBlock, SourceLog, SourceReceipt } from "./custody-verifier.js";
import type { FetchLike } from "./evm-rpc.js";

const HEX = /^0x[0-9a-fA-F]+$/;
const hexBig = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !HEX.test(v)) throw new Error(`bad ${what} in RPC response`);
  return BigInt(v);
};
const hexStr = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !HEX.test(v)) throw new Error(`bad ${what} in RPC response`);
  return v;
};

/**
 * Read-only `FinalitySource` over one JSON-RPC endpoint. It never signs or sends anything.
 * `finalizedBlock()` uses the node's `finalized` tag and returns null when the tag is unsupported
 * or the node has no finalized block; it never substitutes `latest`.
 * Error messages never contain the URL (it may embed an API key).
 */
export class RpcFinalitySource implements FinalitySource {
  private id = 0;

  constructor(
    private readonly url: string,
    private readonly opts: { fetch?: FetchLike; timeoutMs?: number; userAgent?: string; /** Optional second endpoint used only for historical `balanceOf` reads (some nodes prune state). */ stateUrl?: string } = {},
  ) {}

  private async rpc(method: string, params: unknown[], url: string = this.url): Promise<unknown> {
    const doFetch: FetchLike = this.opts.fetch ?? ((u, i) => fetch(u, i));
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": this.opts.userAgent ?? "valtrum-custody-verifier/0.1 (read-only testnet evidence)" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new Error(`EVM RPC ${method} request failed: ${err instanceof Error ? err.name : "error"}`);
    }
    if (!res.ok) throw new Error(`EVM RPC ${method} failed with HTTP status ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`EVM RPC ${method} error: ${body.error.message ?? "unknown"}`);
    return body.result;
  }

  async chainId(): Promise<bigint> {
    return hexBig(await this.rpc("eth_chainId", []), "chain id");
  }

  private async block(tag: string): Promise<SourceBlock | null> {
    const b = (await this.rpc("eth_getBlockByNumber", [tag, false])) as { number?: unknown; hash?: unknown; parentHash?: unknown } | null;
    if (!b) return null;
    return { number: hexBig(b.number, "block number"), hash: hexStr(b.hash, "block hash"), parentHash: hexStr(b.parentHash, "parent hash") };
  }

  async finalizedBlock(): Promise<SourceBlock | null> {
    try {
      return await this.block("finalized");
    } catch {
      return null;
    }
  }

  blockByNumber(number: bigint): Promise<SourceBlock | null> {
    return this.block(`0x${number.toString(16)}`);
  }

  async receipt(transactionHash: string): Promise<SourceReceipt | null> {
    const r = (await this.rpc("eth_getTransactionReceipt", [transactionHash])) as {
      transactionHash?: unknown; status?: unknown; blockNumber?: unknown; blockHash?: unknown;
      logs?: Array<{ address?: unknown; topics?: unknown; data?: unknown; logIndex?: unknown; blockHash?: unknown; transactionHash?: unknown; removed?: unknown }>;
    } | null;
    if (!r) return null;
    const logs: SourceLog[] = (r.logs ?? []).map((l) => {
      if (!Array.isArray(l.topics) || l.topics.some((t) => typeof t !== "string")) throw new Error("bad log topics in RPC response");
      return {
        address: hexStr(l.address, "log address"), topics: l.topics as string[], data: hexStr(l.data, "log data"),
        logIndex: Number(hexBig(l.logIndex, "log index")), blockHash: hexStr(l.blockHash, "log block hash"),
        transactionHash: hexStr(l.transactionHash, "log transaction hash"), removed: l.removed === true,
      };
    });
    return {
      transactionHash: hexStr(r.transactionHash, "transaction hash"), status: hexBig(r.status, "status") === 1n,
      blockNumber: hexBig(r.blockNumber, "block number"), blockHash: hexStr(r.blockHash, "block hash"), logs,
    };
  }

  /** Needs historical state at `blockNumber`; a node that pruned it errors, which the verifier reports as Pending. */
  async balanceOfAt(token: string, account: string, blockNumber: bigint): Promise<bigint> {
    const data = encodeBalanceOf(account);
    const out = await this.rpc("eth_call", [{ to: normalizeAddress(token), data }, `0x${blockNumber.toString(16)}`], this.opts.stateUrl ?? this.url);
    return hexBig(out, "balanceOf result");
  }
}
