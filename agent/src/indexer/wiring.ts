import { readFile } from "node:fs/promises";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import { deriveConfig, DEFAULT_STATE_DIR } from "./cli.js";
import { IndexerEngine } from "./engine.js";
import { RecordedBlockSource, validateRecordedChain } from "./recorded-source.js";
import { parseRetentionDepth } from "./retention.js";
import { JsonFileIndexerStore } from "./store.js";
import type { IndexerConfig, IndexerHealth } from "./types.js";

/**
 * Agent runtime wiring for the read-only indexer. It is OFF unless `INDEXER_ENABLED=true`. There is no
 * live NEAR archival/indexing adapter yet (tracked as open in arena-testnet-integrations), so the only
 * source is a RECORDED chain file (`INDEXER_RECORDED_CHAIN`): blocks and finality in it are fixture
 * assertions, never verified chain state. Enabling it without that file fails closed at startup.
 * The indexer has no write authority and its failure never blocks settlement or payout passes.
 */

export interface IndexerRuntimeConfig {
  recordedChainPath: string;
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
  const recordedChainPath = env.INDEXER_RECORDED_CHAIN?.trim();
  if (!recordedChainPath) {
    throw new Error(
      "INDEXER_RECORDED_CHAIN is required when INDEXER_ENABLED=true: no live block source exists yet, only a recorded chain file (fixture data)",
    );
  }
  const extra = (env.INDEXER_CONTRACTS?.trim() ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const anchorHeight = env.INDEXER_ANCHOR_HEIGHT?.trim();
  if (anchorHeight && !/^(0|[1-9][0-9]*)$/.test(anchorHeight)) throw new Error("INDEXER_ANCHOR_HEIGHT must be a non-negative integer");
  const anchorHash = env.INDEXER_ANCHOR_HASH?.trim();
  return {
    recordedChainPath,
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
  const chain = validateRecordedChain(JSON.parse(await readFile(cfg.recordedChainPath, "utf8")));
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
        source.replace(validateRecordedChain(JSON.parse(await readFile(cfg.recordedChainPath, "utf8"))));
        return await engine.sync();
      } catch (err) {
        log.error("indexer sync failed", { error: errorMessage(err) });
        return null;
      }
    },
    close: () => engine.close(),
  };
}
