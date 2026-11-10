// All transports are injected fixtures. These tests do not qualify a live provider/deployment.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NearDataBlockSource, type NearDataConfig } from "../../src/indexer/near-data-source.js";
import { IndexerEngine } from "../../src/indexer/engine.js";
import { JsonFileIndexerStore } from "../../src/indexer/store.js";
import { config, created } from "./fixtures.js";
import { chainFile } from "./fixtures.js";
import { validateRecordedChain } from "../../src/indexer/recorded-source.js";

const cfg: NearDataConfig = { network: "near-testnet", rpcUrl: "https://rpc.test", dataUrl: "https://data.test",
  genesisHeight: "0", genesisHash: "genesis", qualification: "injected fixture only", contracts: ["arena.testnet"] };
function fixture() {
  const chunk = (height: number) => ({ shard_id: 0, chunk_hash: `c${height}`, height_included: height });
  const header = (height: number) => ({ height, hash: height === 0 ? "genesis" : `h${height}`, prev_hash: height === 1 ? "genesis" : `h${height - 1}`,
    prev_height: height - 1, timestamp_nanosec: "1700000000000000000" });
  const b = (height: number) => ({ header: header(height), chunks: [chunk(height)] });
  const doc = (height: number) => ({ block: b(height), shards: [{ shard_id: 0, chunk: { header: chunk(height) }, receipt_execution_outcomes: [{
    receipt: { receipt_id: `r${height}`, receiver_id: "arena.testnet" },
    execution_outcome: { id: `r${height}`, block_hash: `h${height}`, outcome: { executor_id: "arena.testnet", logs: [created("9007199254740993")], status: { SuccessValue: "" } } },
  }] }] });
  const state = { head: 2, broken: false, network: "testnet", genesis: "genesis", transform: (v: ReturnType<typeof doc>, _h: number): unknown => v };
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (state.broken) return new Response("unavailable", { status: 503 });
    if (url.startsWith(cfg.dataUrl)) { const height = Number(url.split("/").at(-1)); return Response.json(state.transform(doc(height), height)); }
    const req = JSON.parse(String(init.body));
    if (req.method === "status") return Response.json({ result: { chain_id: state.network } });
    const height = req.params.finality ? state.head : req.params.block_id;
    const result = b(height);
    if (height === 0) { result.header.hash = state.genesis; result.header.prev_height = 0; }
    return Response.json({ result });
  });
  return { state, fetcher, source: new NearDataBlockSource(cfg, fetcher) };
}

describe("finalized NEAR Data source", () => {
  it("refuses to promote a recorded file into live provenance", () => {
    const file = chainFile([]);
    expect(() => validateRecordedChain({ ...file, identity: { ...file.identity, sourceType: "live" } })).toThrow(/cannot assert live/);
  });
  it("cross-checks network/genesis/header/shards and keeps receipt and exact battle identity", async () => {
    const h = fixture();
    expect(await h.source.head()).toEqual({ latest: { height: "2", hash: "h2" }, finalized: { height: "2", hash: "h2" } });
    const result = await h.source.blockAt("1");
    expect(result.kind).toBe("block");
    if (result.kind !== "block") throw new Error("block");
    expect(result.block.header.timestampMs).toBe("1700000000000");
    expect(result.block.outcomes[0]).toMatchObject({ receiptId: "r1", executorId: "arena.testnet", success: true });
    expect(h.source.identity()).toMatchObject({ sourceType: "live", genesis: "genesis", qualification: "injected fixture only" });
    expect(await h.source.blockAt("3")).toEqual({ kind: "beyond_head" });
  });
  it("refuses network/genesis mismatches and incomplete/foreign receipt coverage", async () => {
    for (const problem of ["network", "genesis", "shard", "hash", "receipt", "duplicate", "unsafe"] as const) {
      const h = fixture();
      if (problem === "network") h.state.network = "mainnet";
      if (problem === "genesis") h.state.genesis = "foreign";
      if (problem === "network" || problem === "genesis") { await expect(h.source.head()).rejects.toThrow(/identity/); continue; }
      await h.source.head();
      h.state.transform = (d) => {
        if (problem === "shard") d.shards = [];
        if (problem === "hash") d.block.header.hash = "foreign";
        if (problem === "receipt") d.shards[0]!.receipt_execution_outcomes[0]!.receipt.receiver_id = "other.testnet";
        if (problem === "duplicate") d.shards[0]!.receipt_execution_outcomes.push(d.shards[0]!.receipt_execution_outcomes[0]!);
        if (problem === "unsafe") d.block.header.height = 9007199254740992;
        return d;
      };
      await expect(h.source.blockAt("1")).rejects.toThrow();
    }
  });
  it("does not turn null below final head into a skipped or empty block; retries are bounded", async () => {
    const h = fixture(); await h.source.head();
    h.state.transform = () => null;
    expect(await h.source.blockAt("1")).toEqual({ kind: "incomplete" });
    h.fetcher.mockClear(); h.state.broken = true;
    await expect(h.source.head()).rejects.toThrow("unavailable");
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    await expect(h.source.blockAt("9007199254740993")).resolves.toEqual({ kind: "beyond_head" });
  });
  it("persists/replays source identity, preserves finalized state on regression and reports outages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "near-data-"));
    const h = fixture();
    const c = config({ anchorHash: "genesis", sourceFingerprint: h.source.fingerprint });
    let engine = new IndexerEngine(h.source, new JsonFileIndexerStore(dir), c);
    try {
      await engine.open(); expect((await engine.sync()).status).toBe("healthy");
      const digest = engine.projection().digest;
      await engine.close();
      engine = new IndexerEngine(h.source, new JsonFileIndexerStore(dir), c);
      await engine.open(); expect(engine.projection().digest).toBe(digest);
      h.state.head = 1;
      expect((await engine.sync()).status).toBe("degraded");
      expect(engine.health().finalizedHead?.height).toBe("2");
      await engine.sourceUnavailable(); expect(engine.health().status).toBe("degraded");
      expect(engine.confirmations().confirmable).toBe(false);
      await engine.close();
      await expect(new JsonFileIndexerStore(dir).open(config({ anchorHash: "genesis" }))).rejects.toThrow("sourceFingerprint");
    } finally { await engine.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
