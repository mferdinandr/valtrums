import type { BlockAt, BlockRef, BlockSource, RecordedBlock, ReceiptOutcome, SourceIdentity } from "./types.js";

/**
 * Live NEAR block source over the FastNEAR `neardata` HTTP API (owner decision, issue #144). It serves
 * FINALIZED blocks only (`/v0/block/{height}` returns the finalized block), so `latest` and `finalized`
 * are the same head and this adapter never produces provisional blocks. Finality is the provider's
 * assertion, not verified by this process; the identity says `live` and the engine keeps the label.
 *
 * What it validates before handing a block to the engine: the response's height equals the requested
 * one, hash/prev_hash/timestamp are well formed, every shard has an outcome list. A `null` body is
 * ambiguous at the provider (skipped height, not produced yet, or outside its archive range), so the
 * adapter disambiguates from the next block's `prev_height`: a skipped height is only reported as
 * `skipped` when a later block proves no block exists at it; otherwise it is `incomplete` and the
 * engine stops instead of advancing over a gap. Only outcomes executed by allowlisted accounts are
 * kept (the rest of the chain is irrelevant and would be quarantined as `wrong_emitter` noise).
 * Transport failures throw; the runtime reports them as an unavailable sync and retries next pass.
 */

export const NEARDATA_HOSTS: Record<"testnet" | "mainnet", string> = {
  testnet: "https://testnet.neardata.xyz",
  mainnet: "https://mainnet.neardata.xyz",
};

export interface NearDataSourceOptions {
  network: "testnet" | "mainnet";
  /** Accounts whose receipt outcomes are kept (arena plus companion contracts). */
  contracts: string[];
  /** Overrides the default public host for the network. Must be https. */
  baseUrl?: string;
  /** Secret. Sent only as a Bearer header to `baseUrl`, never logged, never forwarded across a redirect. */
  apiKey?: string;
  fetchFn?: typeof fetch;
  /** Minimum gap between provider requests (public tier is 180 requests per minute per IP). */
  minIntervalMs?: number;
  timeoutMs?: number;
  /** Retries after the first attempt for transport errors, 5xx and 429. */
  retries?: number;
  /** Heights probed above a `null` block to prove it is skipped. */
  skipProbe?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class NearDataError extends Error {
  constructor(reason: string) {
    super(`neardata source: ${reason}`);
    this.name = "NearDataError";
  }
}

interface RawHeader {
  height: number | string;
  hash: string;
  prev_hash: string;
  prev_height?: number | string | null;
  timestamp_nanosec?: string;
}
interface RawOutcome {
  receipt?: { receipt_id?: string };
  execution_outcome?: { outcome?: { executor_id?: string; logs?: string[]; status?: unknown } };
}
interface RawBlock {
  block?: { header?: RawHeader };
  shards?: { receipt_execution_outcomes?: RawOutcome[] }[];
}

const DEC = /^(0|[1-9][0-9]*)$/;
const HASH = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/; // NEAR hashes are base58

function dec(v: unknown, what: string): string {
  const s = typeof v === "number" ? (Number.isSafeInteger(v) ? String(v) : "") : typeof v === "string" ? v : "";
  if (!DEC.test(s)) throw new NearDataError(`${what} is not a safe integer`);
  return s;
}

function succeeded(status: unknown): boolean {
  if (typeof status !== "object" || status === null) return false;
  return "SuccessValue" in status || "SuccessReceiptId" in status;
}

export class NearDataBlockSource implements BlockSource {
  private readonly base: string;
  private readonly allow: Set<string>;
  private readonly fetchFn: typeof fetch;
  private readonly minInterval: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly probe: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache = new Map<string, RawBlock | null>();
  private nextSlot = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: NearDataSourceOptions) {
    this.base = (opts.baseUrl ?? NEARDATA_HOSTS[opts.network]).replace(/\/+$/, "");
    if (!/^https:\/\//.test(this.base)) throw new NearDataError("base URL must be https");
    if (opts.contracts.length === 0) throw new NearDataError("at least one allowlisted contract is required");
    this.allow = new Set(opts.contracts);
    this.fetchFn = opts.fetchFn ?? fetch;
    this.minInterval = opts.minIntervalMs ?? 400;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retries = opts.retries ?? 3;
    this.probe = opts.skipProbe ?? 64;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  identity(): SourceIdentity {
    return { network: `near-${this.opts.network}`, sourceType: "live" };
  }

  async head(): Promise<{ latest: BlockRef | null; finalized: BlockRef | null }> {
    const raw = await this.getJson("/v0/last_block/final");
    if (raw === null) return { latest: null, finalized: null };
    const header = this.header(raw);
    const ref = { height: dec(header.height, "head height"), hash: this.hash(header.hash, "head hash") };
    // Only finalized blocks are served, so the processable head and the finalized head coincide.
    return { latest: ref, finalized: ref };
  }

  async blockAt(height: string): Promise<BlockAt> {
    if (!DEC.test(height)) throw new NearDataError("height must be a non-negative integer");
    const head = await this.head();
    if (head.finalized === null || BigInt(height) > BigInt(head.finalized.height)) return { kind: "beyond_head" };
    const raw = await this.fetchBlock(height);
    if (raw === null) return this.classifyMissing(height);
    const header = this.header(raw);
    if (dec(header.height, "block height") !== height) throw new NearDataError(`provider returned height ${String(header.height)} for ${height}`);
    if (!Array.isArray(raw.shards) || raw.shards.length === 0 || raw.shards.some((s) => !Array.isArray(s?.receipt_execution_outcomes))) {
      return { kind: "incomplete" };
    }
    return { kind: "block", block: this.toRecorded(raw, header) };
  }

  /** A `null` body is a skip only when a later block proves nothing sits at `height`. */
  private async classifyMissing(height: string): Promise<BlockAt> {
    const h = BigInt(height);
    for (let i = 1; i <= this.probe; i++) {
      const next = await this.fetchBlock((h + BigInt(i)).toString());
      if (next === null) continue;
      const prev = this.header(next).prev_height;
      if (prev === undefined || prev === null) return { kind: "incomplete" };
      const prevHeight = BigInt(dec(prev, "prev_height"));
      return prevHeight < h ? { kind: "skipped" } : { kind: "incomplete" };
    }
    return { kind: "incomplete" };
  }

  private header(raw: RawBlock): RawHeader {
    const header = raw.block?.header;
    if (!header) throw new NearDataError("block has no header");
    return header;
  }

  private hash(v: unknown, what: string): string {
    if (typeof v !== "string" || !HASH.test(v)) throw new NearDataError(`${what} is not a valid hash`);
    return v;
  }

  private toRecorded(raw: RawBlock, header: RawHeader): RecordedBlock {
    const nanos = header.timestamp_nanosec;
    if (typeof nanos !== "string" || !DEC.test(nanos)) throw new NearDataError("block timestamp is missing");
    const outcomes: ReceiptOutcome[] = [];
    for (const shard of raw.shards ?? []) {
      for (const o of shard.receipt_execution_outcomes ?? []) {
        const inner = o.execution_outcome?.outcome;
        const executor = inner?.executor_id;
        const receiptId = o.receipt?.receipt_id;
        if (typeof executor !== "string" || !this.allow.has(executor)) continue;
        if (typeof receiptId !== "string" || receiptId.length === 0) throw new NearDataError("allowlisted outcome has no receipt id");
        if (!Array.isArray(inner?.logs) || inner.logs.some((l) => typeof l !== "string")) throw new NearDataError("outcome logs are malformed");
        outcomes.push({ receiptId, executorId: executor, success: succeeded(inner?.status), logs: inner.logs as string[] });
      }
    }
    return {
      network: `near-${this.opts.network}`,
      // The executing account of each outcome is the emitter identity; this is only the default.
      contract: this.opts.contracts[0] as string,
      header: {
        height: dec(header.height, "block height"),
        hash: this.hash(header.hash, "block hash"),
        parentHash: this.hash(header.prev_hash, "parent hash"),
        timestampMs: (BigInt(nanos) / 1_000_000n).toString(),
      },
      outcomes,
      complete: true,
      // The provider serves finalized blocks; that is its assertion and is not verified here.
      finalizedDeclared: true,
    };
  }

  private async fetchBlock(height: string): Promise<RawBlock | null> {
    if (this.cache.has(height)) return this.cache.get(height) ?? null;
    const raw = await this.getJson(`/v0/block/${height}`);
    this.cache.set(height, raw);
    if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value as string);
    return raw;
  }

  /** One rate-limited, bounded-retry GET. A `null` JSON body is returned as null. */
  private async getJson(path: string): Promise<RawBlock | null> {
    let lastError = "request failed";
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      await this.pace();
      try {
        const res = await this.request(`${this.base}${path}`);
        if (res.status === 429 || res.status >= 500) {
          lastError = `HTTP ${res.status}`;
        } else if (!res.ok) {
          throw new NearDataError(`HTTP ${res.status} for ${path}`);
        } else {
          const text = await res.text();
          if (text.trim() === "" || text.trim() === "null") return null;
          const parsed = JSON.parse(text) as unknown;
          if (parsed === null) return null;
          if (typeof parsed !== "object") throw new NearDataError("response is not a block document");
          return parsed as RawBlock;
        }
      } catch (err) {
        if (err instanceof NearDataError) throw err;
        lastError = err instanceof Error ? err.name : "request failed";
      }
      if (attempt < this.retries) await this.sleep(Math.min(250 * 2 ** attempt, 4_000));
    }
    throw new NearDataError(`unavailable after retries (${lastError})`);
  }

  /** Follows at most 3 redirects, only to https hosts of the provider; the API key stays on the first host. */
  private async request(url: string): Promise<Response> {
    let target = url;
    for (let hop = 0; hop <= 3; hop++) {
      const first = hop === 0;
      const res = await this.fetchFn(target, {
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/json", ...(first && this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
      });
      if (res.status < 300 || res.status >= 400) return res;
      const location = res.headers.get("location");
      if (!location) throw new NearDataError("redirect without a location");
      const next = new URL(location, target);
      if (next.protocol !== "https:" || !(next.hostname.endsWith(".neardata.xyz") || next.hostname.endsWith(".fastnear.com"))) {
        throw new NearDataError("redirect to an unexpected host refused");
      }
      target = next.toString();
    }
    throw new NearDataError("too many redirects");
  }

  private async pace(): Promise<void> {
    const run = async () => {
      const wait = this.nextSlot - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.nextSlot = Math.max(Date.now(), this.nextSlot) + this.minInterval;
    };
    this.queue = this.queue.then(run, run);
    await this.queue;
  }
}
