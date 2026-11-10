import { createHash } from "node:crypto";
import { z } from "zod";
import { integer } from "../mcp/application-contract.js";
import type { BlockAt, BlockRef, BlockSource, ReceiptOutcome, SourceIdentity } from "./types.js";

const text = z.string().min(1).max(256);
const uint = z.unknown().transform((v) => integer(v));
const header = z.object({ height: uint, hash: text, prev_hash: text, prev_height: uint, timestamp_nanosec: uint });
const chunkHeader = z.object({ shard_id: uint, chunk_hash: text, height_included: uint });
const block = z.object({ header, chunks: z.array(chunkHeader).min(1).max(1024) });
const document = z.object({ block, shards: z.array(z.object({
  shard_id: uint,
  chunk: z.object({ header: chunkHeader }).nullable(),
  receipt_execution_outcomes: z.array(z.object({
    receipt: z.object({ receipt_id: text.optional(), receiver_id: text.optional() }).passthrough(),
    execution_outcome: z.object({ block_hash: text, id: text, outcome: z.object({ executor_id: text,
      logs: z.array(z.string().max(1024 * 1024)).max(10000), status: z.record(z.string(), z.unknown()),
    }) }),
  })).max(100000),
})).max(1024) });

export interface NearDataConfig {
  network: "near-testnet" | "near-mainnet";
  rpcUrl: string;
  dataUrl: string;
  genesisHeight: string;
  genesisHash: string;
  /** Reviewed provider/coverage record, not an env flag asserting cryptographic completeness. */
  qualification: string;
  contracts: string[];
}
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Finalized-only, read-only NEAR Data + independent archival RPC header cross-checks. */
export class NearDataBlockSource implements BlockSource {
  private finalized: BlockRef | null = null;
  readonly fingerprint: string;
  constructor(readonly config: NearDataConfig, private readonly doFetch: FetchLike = fetch) {
    for (const raw of [config.rpcUrl, config.dataUrl]) {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("indexer source URLs must be HTTPS origins without credentials");
    }
    integer(config.genesisHeight);
    if (!config.genesisHash || !config.qualification || config.qualification.length > 256 || !config.contracts.length) throw new Error("live source requires genesis and provider qualification evidence");
    this.fingerprint = createHash("sha256").update(JSON.stringify([config.network, config.genesisHeight, config.genesisHash, config.dataUrl, config.qualification])).digest("hex");
  }
  identity(): SourceIdentity {
    return { network: this.config.network, sourceType: "live", genesis: this.config.genesisHash,
      provider: new URL(this.config.dataUrl).hostname, qualification: this.config.qualification };
  }
  private async json(url: string, init: RequestInit): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.doFetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error("source HTTP failure");
        const reader = res.body?.getReader();
        if (!reader) throw new Error("missing source body");
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 32 * 1024 * 1024) { await reader.cancel(); throw new Error("source response exceeds limit"); }
          chunks.push(part.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        if (attempt === 1) throw new Error("live indexer source unavailable or invalid");
      }
    }
    throw new Error("live source unavailable");
  }
  private async rpc(method: string, params: unknown): Promise<unknown> {
    const response = await this.json(this.config.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "indexer", method, params }) });
    const envelope = z.object({ result: z.unknown(), error: z.unknown().optional() }).parse(response);
    if (envelope.error || envelope.result === undefined) throw new Error("archival RPC request unavailable");
    return envelope.result;
  }
  private rpcHeight(height: string): number {
    integer(height);
    if (BigInt(height) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("RPC height boundary is unsafe");
    return Number(height);
  }
  async head() {
    // Revalidate identity every pass, not only at construction.
    const status = z.object({ chain_id: z.string() }).parse(await this.rpc("status", []));
    if (`near-${status.chain_id}` !== this.config.network) throw new Error("live source network identity mismatch");
    const genesis = z.object({ header: z.object({ height: uint, hash: text }) }).parse(await this.rpc("block", { block_id: this.rpcHeight(this.config.genesisHeight) }));
    if (genesis.header.hash !== this.config.genesisHash || genesis.header.height !== this.config.genesisHeight) throw new Error("live source genesis identity mismatch");
    const final = block.parse(await this.rpc("block", { finality: "final" }));
    this.finalized = { height: final.header.height, hash: final.header.hash };
    // The source exposes only the finalized stream; optimistic data is deliberately not ingested.
    return { latest: this.finalized, finalized: this.finalized };
  }
  async blockAt(height: string): Promise<BlockAt> {
    integer(height);
    if (!this.finalized) return { kind: "incomplete" };
    if (BigInt(height) > BigInt(this.finalized.height)) return { kind: "beyond_head" };
    const raw = await this.json(`${this.config.dataUrl.replace(/\/$/, "")}/v0/block/${height}`, { method: "GET" });
    if (raw === null) {
      // A null provider response is never empty state. Only a canonical successor can prove a skip.
      for (let n = 1n; n <= 8n && BigInt(height) + n <= BigInt(this.finalized.height); n++) {
        const nextHeight = (BigInt(height) + n).toString();
        const next = await this.json(`${this.config.dataUrl.replace(/\/$/, "")}/v0/block/${nextHeight}`, { method: "GET" });
        if (next === null) continue;
        const canonical = block.parse(await this.rpc("block", { block_id: this.rpcHeight(nextHeight) }));
        if (canonical.header.height !== nextHeight) throw new Error("canonical successor height mismatch");
        return BigInt(canonical.header.prev_height) < BigInt(height) ? { kind: "skipped" } : { kind: "incomplete" };
      }
      return { kind: "incomplete" };
    }
    const doc = document.parse(raw);
    const canonical = block.parse(await this.rpc("block", { block_id: this.rpcHeight(height) }));
    const h = doc.block.header;
    if (h.height !== height || canonical.header.height !== height || h.hash !== canonical.header.hash || h.prev_hash !== canonical.header.prev_hash || h.prev_height !== canonical.header.prev_height || h.timestamp_nanosec !== canonical.header.timestamp_nanosec) throw new Error("NEAR Data / archival RPC header mismatch");
    if (height === this.finalized.height && h.hash !== this.finalized.hash) throw new Error("finalized hash changed");
    const expected = new Map(canonical.chunks.map((c) => [c.shard_id, c]));
    if (expected.size !== canonical.chunks.length || expected.size !== doc.shards.length || JSON.stringify(doc.block.chunks) !== JSON.stringify(canonical.chunks)) throw new Error("incomplete or conflicting shard coverage");
    const shards = [...doc.shards].sort((a, b) => BigInt(a.shard_id) < BigInt(b.shard_id) ? -1 : 1);
    const seenShards = new Set<string>(); const seenReceipts = new Set<string>(); const outcomes: ReceiptOutcome[] = [];
    for (const shard of shards) {
      const c = expected.get(shard.shard_id);
      if (!c || seenShards.has(shard.shard_id)) throw new Error("missing or duplicate shard");
      seenShards.add(shard.shard_id);
      if (shard.chunk ? shard.chunk.header.chunk_hash !== c.chunk_hash || shard.chunk.header.shard_id !== c.shard_id : c.height_included === height) throw new Error("missing or foreign chunk");
      for (const item of shard.receipt_execution_outcomes) {
        const e = item.execution_outcome; const o = e.outcome;
        if (e.block_hash !== h.hash || seenReceipts.has(e.id) || (item.receipt.receipt_id && item.receipt.receipt_id !== e.id) || (item.receipt.receiver_id && item.receipt.receiver_id !== o.executor_id)) throw new Error("receipt identity mismatch");
        seenReceipts.add(e.id);
        const statusKeys = Object.keys(o.status);
        if (statusKeys.length !== 1 || !["SuccessValue", "SuccessReceiptId", "Failure"].includes(statusKeys[0]!)) throw new Error("incomplete execution outcome");
        const status = o.status[statusKeys[0]!];
        if (statusKeys[0] === "Failure" ? !status || typeof status !== "object" || Array.isArray(status) : typeof status !== "string") throw new Error("malformed execution status");
        if (this.config.contracts.includes(o.executor_id)) outcomes.push({ receiptId: e.id, executorId: o.executor_id,
          success: statusKeys[0] !== "Failure", logs: o.logs });
      }
    }
    return { kind: "block", block: { network: this.config.network, contract: this.config.contracts[0]!,
      header: { height, hash: h.hash, parentHash: h.prev_hash, timestampMs: (BigInt(h.timestamp_nanosec) / 1_000_000n).toString() },
      outcomes, complete: true, finalizedDeclared: true } };
  }
}
