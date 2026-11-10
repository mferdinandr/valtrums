import { readFile } from "node:fs/promises";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import { deriveConfig, DEFAULT_STATE_DIR } from "./cli.js";
import { IndexerEngine } from "./engine.js";
import { NearDataBlockSource } from "./live-source.js";
import { RecordedBlockSource, validateRecordedChain } from "./recorded-source.js";
import { parseRetentionDepth } from "./retention.js";
import { JsonFileIndexerStore } from "./store.js";
import type { IndexerConfig, IndexerHealth } from "./types.js";

/**
 * Agent runtime wiring for the read-only indexer. It is OFF unless `INDEXER_ENABLED=true`. Two sources,
 * chosen explicitly by `INDEXER_SOURCE` (default `recorded`, so existing config is unchanged):
 *  - `recorded`: a RECORDED chain file (`INDEXER_RECORDED_CHAIN`); blocks and finality in it are fixture
 *    assertions, never verified chain state. Enabling it without that file fails closed at startup.
 *  - `live`: the FastNEAR neardata HTTP API (finalized blocks only; finality is the provider's
 *    assertion). It needs `INDEXER_ANCHOR_HEIGHT` and `INDEXER_ANCHOR_HASH` (the parent hash of the first
 *    block, declared by the operator, never guessed); a recorded file is never read in this mode, and a
 *    recorded fixture can never acquire the `live` source label from a flag.
 * The indexer has no write authority and its failure never blocks settlement or payout passes.
 */

export interface IndexerRuntimeConfig {
  source: "recorded" | "live";
  /** Set when `source` is "recorded". */
  recordedChainPath?: string;
  /** Set when `source` is "live". */
  live?: { network: "testnet" | "mainnet"; baseUrl?: string; apiKey?: string; maxBlocksPerSync: number };
  stateDir: string;
  /** Allowlisted emitter accounts: the arena plus any `INDEXER_CONTRACTS` (for example backing and payout). */
  contracts: string[];
  retentionDepth: number;
  anchorHeight?: string;
  anchorHash?: string;
}

export function loadIndexerRuntimeConfig(
  env: Record<string, string | undefined>,
  arenaContractId: string,
): IndexerRuntimeConfig | null {
  if (env.INDEXER_ENABLED?.trim() !== "true") return null;
  const sourceRaw = env.INDEXER_SOURCE?.trim() || "recorded";
  if (sourceRaw !== "recorded" && sourceRaw !== "live") throw new Error('INDEXER_SOURCE must be "recorded" or "live"');
  const recordedChainPath = env.INDEXER_RECORDED_CHAIN?.trim();
  if (sourceRaw === "recorded" && !recordedChainPath) {
    throw new Error(
      "INDEXER_RECORDED_CHAIN is required when INDEXER_ENABLED=true and INDEXER_SOURCE is recorded (fixture data); set INDEXER_SOURCE=live for the live block source",
    );
  }
  if (sourceRaw === "live" && recordedChainPath) {
    throw new Error("INDEXER_RECORDED_CHAIN must not be set with INDEXER_SOURCE=live: a recorded file is never mixed with the live source");
  }
  const extra = (env.INDEXER_CONTRACTS?.trim() ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const anchorHeight = env.INDEXER_ANCHOR_HEIGHT?.trim();
  if (anchorHeight && !/^(0|[1-9][0-9]*)$/.test(anchorHeight)) throw new Error("INDEXER_ANCHOR_HEIGHT must be a non-negative integer");
  const anchorHash = env.INDEXER_ANCHOR_HASH?.trim();
  let live: IndexerRuntimeConfig["live"];
  if (sourceRaw === "live") {
    if (!anchorHeight) throw new Error("INDEXER_ANCHOR_HEIGHT is required with INDEXER_SOURCE=live (the first block to index)");
    // Live blocks always carry a parent hash, so the first block can only be linked to a declared anchor.
    if (!anchorHash) throw new Error("INDEXER_ANCHOR_HASH is required with INDEXER_SOURCE=live (the hash of the block before INDEXER_ANCHOR_HEIGHT)");
    const network = env.NEAR_NETWORK?.trim() || "testnet";
    if (network !== "testnet" && network !== "mainnet") throw new Error('NEAR_NETWORK must be "testnet" or "mainnet"');
    const baseUrl = env.INDEXER_NEARDATA_URL?.trim();
    if (baseUrl && !/^https:\/\//.test(baseUrl)) throw new Error("INDEXER_NEARDATA_URL must be an https URL");
    const apiKey = env.INDEXER_NEARDATA_API_KEY?.trim();
    const perSync = Number(env.INDEXER_MAX_BLOCKS_PER_SYNC?.trim() || "200");
    if (!Number.isInteger(perSync) || perSync < 1 || perSync > 10_000) throw new Error("INDEXER_MAX_BLOCKS_PER_SYNC must be an integer from 1 to 10000");
    live = { network, ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}), maxBlocksPerSync: perSync };
  }
  return {
    source: sourceRaw,
    ...(recordedChainPath ? { recordedChainPath } : {}),
    ...(live ? { live } : {}),
    stateDir: env.INDEXER_STATE_DIR?.trim() || DEFAULT_STATE_DIR,
    contracts: [...new Set([arenaContractId, ...extra])],
    retentionDepth: parseRetentionDepth(env.INDEXER_RETENTION_DEPTH),
    ...(anchorHeight ? { anchorHeight } : {}),
    ...(anchorHash ? { anchorHash } : {}),
  };
}

export interface IndexerRuntime {
  /** One ingest and reconcile pass. Never throws: a failure is logged and reported as null. */
  sync(): Promise<IndexerHealth | null>;
  close(): Promise<void>;
}

/** Open the engine over the recorded chain. Throws on a bad chain file, a conflicting config or corrupt state. */
export async function createIndexerRuntime(cfg: IndexerRuntimeConfig, log: Logger = silentLogger): Promise<IndexerRuntime> {
  if (cfg.source === "live") return createLiveRuntime(cfg, log);
  if (!cfg.recordedChainPath) throw new Error("recorded indexer source needs a recorded chain path");
  const recordedPath = cfg.recordedChainPath;
  const chain = validateRecordedChain(JSON.parse(await readFile(recordedPath, "utf8")));
  const flags = new Map<string, string>([["contract", cfg.contracts.join(",")]]);
  if (cfg.anchorHeight) flags.set("anchor-height", cfg.anchorHeight);
  if (cfg.anchorHash) flags.set("anchor-hash", cfg.anchorHash);
  const config: IndexerConfig = deriveConfig(chain, flags);
  const source = new RecordedBlockSource(chain);
  const engine = new IndexerEngine(source, new JsonFileIndexerStore(cfg.stateDir), config, {
    finalizedRetentionDepth: cfg.retentionDepth,
    log,
  });
  await engine.open();
  log.warn("indexer enabled over a RECORDED chain file; blocks and finality are fixture assertions, not live chain state", {
    stateDir: cfg.stateDir,
    contracts: cfg.contracts,
  });
  return {
    async sync() {
      try {
        // Re-read the recorded file so an updated recording is picked up; the engine reconciles the difference.
        source.replace(validateRecordedChain(JSON.parse(await readFile(recordedPath, "utf8"))));
        return await engine.sync();
      } catch (err) {
        log.error("indexer sync failed", { error: errorMessage(err) });
        return null;
      }
    },
    close: () => engine.close(),
  };
}

/** Live runtime: finalized NEAR blocks from neardata. Never reads a recorded file. */
async function createLiveRuntime(cfg: IndexerRuntimeConfig, log: Logger): Promise<IndexerRuntime> {
  const live = cfg.live;
  if (!live || !cfg.anchorHeight) throw new Error("live indexer source needs its settings and an anchor height");
  const source = new NearDataBlockSource({
    network: live.network,
    contracts: cfg.contracts,
    ...(live.baseUrl ? { baseUrl: live.baseUrl } : {}),
    ...(live.apiKey ? { apiKey: live.apiKey } : {}),
  });
  const config: IndexerConfig = {
    network: source.identity().network,
    contracts: cfg.contracts,
    standard: "valtrum",
    supportedVersions: ["1.0.0"],
    schemaVersion: "indexer-v1",
    reducerVersion: "projection-v1",
    anchorHash: cfg.anchorHash ?? null,
    anchorHeight: cfg.anchorHeight,
    retainedDepth: 1024,
  };
  const engine = new IndexerEngine(source, new JsonFileIndexerStore(cfg.stateDir), config, {
    finalizedRetentionDepth: cfg.retentionDepth,
    maxBlocksPerSync: live.maxBlocksPerSync,
    log,
  });
  await engine.open();
  log.info("indexer enabled over the LIVE neardata source; only finalized blocks are indexed and finality is the provider's assertion", {
    stateDir: cfg.stateDir,
    network: config.network,
    contracts: cfg.contracts,
    anchorHeight: cfg.anchorHeight,
    maxBlocksPerSync: live.maxBlocksPerSync,
  });
  return {
    async sync() {
      try {
        return await engine.sync();
      } catch (err) {
        // A provider outage is an unavailable sync, retried on the next pass; stored state is untouched.
        log.error("indexer sync failed", { error: errorMessage(err) });
        return null;
      }
    },
    close: () => engine.close(),
  };
}
