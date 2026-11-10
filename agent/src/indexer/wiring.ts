import { readFile } from "node:fs/promises";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import { deriveConfig, DEFAULT_STATE_DIR } from "./cli.js";
import { IndexerEngine } from "./engine.js";
import { RecordedBlockSource, validateRecordedChain } from "./recorded-source.js";
import { parseRetentionDepth } from "./retention.js";
import { JsonFileIndexerStore } from "./store.js";
import type { IndexerConfig, IndexerHealth } from "./types.js";
import { NearDataBlockSource, type NearDataConfig } from "./near-data-source.js";

/**
 * Agent runtime wiring for the read-only indexer. It is OFF unless `INDEXER_ENABLED=true`. The
 * default source is a RECORDED chain file (`INDEXER_RECORDED_CHAIN`): its finality is a fixture
 * assertion. INDEXER_SOURCE=near-data separately enables the qualified, finalized-only live adapter
 * with pinned genesis/anchor and RPC header cross-checks. No source mode falls back to the other.
 * The indexer has no write authority and its failure never blocks settlement or payout passes.
 */

export interface IndexerRuntimeConfig {
  recordedChainPath?: string;
  live?: NearDataConfig;
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
  const mode = env.INDEXER_SOURCE?.trim() || "recorded";
  if (mode !== "recorded" && mode !== "near-data") throw new Error("INDEXER_SOURCE must be recorded or near-data");
  const recordedChainPath = env.INDEXER_RECORDED_CHAIN?.trim();
  if (mode === "recorded" && !recordedChainPath) {
    throw new Error(
      "INDEXER_RECORDED_CHAIN is required for recorded mode; live mode requires explicit INDEXER_SOURCE=near-data and qualification",
    );
  }
  const extra = (env.INDEXER_CONTRACTS?.trim() ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const anchorHeight = env.INDEXER_ANCHOR_HEIGHT?.trim();
  if (anchorHeight && !/^(0|[1-9][0-9]*)$/.test(anchorHeight)) throw new Error("INDEXER_ANCHOR_HEIGHT must be a non-negative integer");
  const anchorHash = env.INDEXER_ANCHOR_HASH?.trim();
  const contracts = [...new Set([arenaContractId, ...extra])];
  let live: NearDataConfig | undefined;
  if (mode === "near-data") {
    if (recordedChainPath) throw new Error("recorded and live indexer sources cannot be combined");
    const network = env.NEAR_NETWORK?.trim() || "testnet";
    if (network !== "testnet" && network !== "mainnet") throw new Error("invalid live indexer network");
    const genesisHash = env.INDEXER_GENESIS_HASH?.trim();
    const genesisHeight = env.INDEXER_GENESIS_HEIGHT?.trim();
    const qualification = env.INDEXER_PROVIDER_EVIDENCE?.trim();
    if (!anchorHeight || !anchorHash || !genesisHash || !genesisHeight || !qualification) throw new Error("live indexer requires explicit anchor, genesis and INDEXER_PROVIDER_EVIDENCE");
    live = { network: `near-${network}`, rpcUrl: env.NEAR_RPC_URL?.trim() || `https://archival-rpc.${network}.near.org`,
      dataUrl: env.INDEXER_NEARDATA_URL?.trim() || `https://${network}.neardata.xyz`, genesisHeight, genesisHash, qualification, contracts };
    new NearDataBlockSource(live); // Validate startup config without making network requests.
  }
  return {
    ...(live ? { live } : { recordedChainPath: recordedChainPath! }),
    stateDir: env.INDEXER_STATE_DIR?.trim() || DEFAULT_STATE_DIR,
    contracts,
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

/** Open the configured source. Conflicting identity/config or corrupt state fails closed. */
export async function createIndexerRuntime(cfg: IndexerRuntimeConfig, log: Logger = silentLogger): Promise<IndexerRuntime> {
  const chain = cfg.live ? null : validateRecordedChain(JSON.parse(await readFile(cfg.recordedChainPath!, "utf8")));
  const flags = new Map<string, string>([["contract", cfg.contracts.join(",")]]);
  if (cfg.anchorHeight) flags.set("anchor-height", cfg.anchorHeight);
  if (cfg.anchorHash) flags.set("anchor-hash", cfg.anchorHash);
  const source = cfg.live ? new NearDataBlockSource(cfg.live) : new RecordedBlockSource(chain!);
  const config: IndexerConfig = deriveConfig(chain ?? { identity: source.identity(), blocks: [] }, flags);
  if (source instanceof NearDataBlockSource) config.sourceFingerprint = source.fingerprint;
  const engine = new IndexerEngine(source, new JsonFileIndexerStore(cfg.stateDir), config, {
    finalizedRetentionDepth: cfg.retentionDepth,
    log,
    ...(cfg.live ? { maxBlocksPerSync: 20 } : {}),
  });
  await engine.open();
  log.warn(cfg.live ? "live finalized NEAR Data indexer enabled; completeness trusts qualified provider, headers cross-checked with archival RPC" : "indexer enabled over a RECORDED chain file; blocks and finality are fixture assertions, not live chain state", {
    stateDir: cfg.stateDir,
    contracts: cfg.contracts,
  });
  return {
    async sync() {
      try {
        // Re-read the recorded file so an updated recording is picked up; the engine reconciles the difference.
        if (source instanceof RecordedBlockSource) source.replace(validateRecordedChain(JSON.parse(await readFile(cfg.recordedChainPath!, "utf8"))));
        return await engine.sync();
      } catch (err) {
        log.error("indexer sync failed", { error: cfg.live ? "live read source unavailable or invalid" : errorMessage(err) });
        if (cfg.live) {
          try { return await engine.sourceUnavailable(); }
          catch { log.error("cannot persist live indexer failure health"); }
        }
        return null;
      }
    },
    close: () => engine.close(),
  };
}
