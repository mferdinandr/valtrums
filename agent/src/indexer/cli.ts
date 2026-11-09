import { readFile } from "node:fs/promises";
import { argv, env as processEnv } from "node:process";
import { fileURLToPath } from "node:url";
import { IndexerEngine } from "./engine.js";
import { buildProjection } from "./projection.js";
import { parseRetentionDepth } from "./retention.js";
import { RecordedBlockSource, validateRecordedChain } from "./recorded-source.js";
import { JsonFileIndexerStore } from "./store.js";
import type { IndexerConfig, IndexerHealthStatus } from "./types.js";

/**
 * Read-only indexer CLI: import recorded block envelopes into a state directory, report status, and
 * replay the committed journal to rebuild/verify the projection. It never signs or submits anything.
 * Machine-readable JSON goes to stdout; human notes go to stderr so the two never mix.
 */

export const DEFAULT_STATE_DIR = "./.agent-state/indexer";

/**
 * Process exit code for a health status. A degraded or reconciliation-required indexer cannot vouch
 * for its projection as current truth, so it exits non-zero; pending (still catching up) is not an
 * error. Distinct codes let a caller tell the two failure modes apart.
 */
function exitForHealth(status: IndexerHealthStatus): number {
  if (status === "reconciliation_required") return 2;
  if (status === "degraded") return 3;
  return 0;
}

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const consoleIo: CliIo = { out: (l) => console.log(l), err: (l) => console.error(l) };

interface Parsed {
  command: string | undefined;
  flags: Map<string, string>;
}

function parseArgs(args: string[]): Parsed {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next === undefined) throw new Error(`flag ${a} needs a value`);
      flags.set(a.slice(2), next);
      i++;
    } else {
      positional.push(a);
    }
  }
  return { command: positional[0], flags };
}

export function deriveConfig(chain: ReturnType<typeof validateRecordedChain>, flags: Map<string, string>): IndexerConfig {
  const contracts = flags.has("contract")
    ? flags.get("contract")!.split(",").map((c) => c.trim()).filter(Boolean)
    : [...new Set(chain.blocks.map((b) => b.contract))].sort();
  const heights = chain.blocks.map((b) => b.header.height);
  const lowest = heights.length > 0 ? heights.reduce((m, h) => (BigInt(h) < BigInt(m) ? h : m), heights[0]!) : "1";
  return {
    network: flags.get("network") ?? chain.identity.network,
    contracts,
    standard: flags.get("standard") ?? "valtrum",
    supportedVersions: (flags.get("versions") ?? "1.0.0").split(",").map((v) => v.trim()),
    schemaVersion: "indexer-v1",
    reducerVersion: "projection-v1",
    anchorHash: flags.get("anchor-hash") ?? null,
    anchorHeight: flags.get("anchor-height") ?? lowest,
    retainedDepth: 1024,
  };
}

const stateDir = (flags: Map<string, string>, env: Record<string, string | undefined>): string =>
  flags.get("dir") ?? env.INDEXER_STATE_DIR?.trim() ?? DEFAULT_STATE_DIR;

export async function runIndexerCli(
  args: string[],
  env: Record<string, string | undefined> = processEnv,
  io: CliIo = consoleIo,
): Promise<number> {
  const parsed = parseArgs(args);
  const dir = stateDir(parsed.flags, env);

  switch (parsed.command) {
    case "import": {
      const chainPath = parsed.flags.get("chain");
      if (!chainPath) {
        io.err("usage: import --chain <file.json> [--dir <state>] [--contract a,b] [--network n] [--retention-depth n]");
        return 1;
      }
      let chain;
      try {
        chain = validateRecordedChain(JSON.parse(await readFile(chainPath, "utf8")));
      } catch (err) {
        io.err(`cannot read recorded chain: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
      let depth: number;
      try {
        depth = parseRetentionDepth(parsed.flags.get("retention-depth") ?? env.INDEXER_RETENTION_DEPTH, "retention depth");
      } catch (err) {
        io.err(err instanceof Error ? err.message : String(err));
        return 1;
      }
      const engine = new IndexerEngine(new RecordedBlockSource(chain), new JsonFileIndexerStore(dir), deriveConfig(chain, parsed.flags), { finalizedRetentionDepth: depth });
      await engine.open();
      try {
        // Drain to the head: keep syncing until the processed head stops advancing.
        let last: string | null = null;
        let health = await engine.health();
        for (let i = 0; i < 100_000; i++) {
          health = await engine.sync();
          const head = health.processedHead?.height ?? null;
          if (head === last) break;
          last = head;
        }
        const proj = engine.projection();
        io.out(JSON.stringify({ command: "import", status: health.status, reason: health.reason, processedHead: health.processedHead, finalizedHead: health.finalizedHead, quarantined: health.quarantined, digest: proj.digest, battles: Object.keys(proj.battles).length }));
        return exitForHealth(health.status);
      } finally {
        await engine.close();
      }
    }
    case "status": {
      const state = await new JsonFileIndexerStore(dir).read();
      if (!state) {
        io.out(JSON.stringify({ command: "status", state: "missing", dir }));
        return 0;
      }
      io.out(
        JSON.stringify({
          command: "status",
          status: state.health.status,
          reason: state.health.reason,
          network: state.config.network,
          contracts: state.config.contracts,
          processedHead: state.cursors.processedHead,
          finalizedHead: state.cursors.finalizedHead,
          journal: state.journal.length,
          quarantined: state.diagnostics.length,
          diagnosticsDropped: state.diagnosticsDropped,
          ignoredLogs: state.ignoredLogs,
          blocks: state.blocks.length,
          // A summary of pruned finalized history, not raw history; null until the first prune.
          checkpoint: state.checkpoint,
          reorgSuspension: state.reorgSuspension,
        }),
      );
      return exitForHealth(state.health.status);
    }
    case "replay":
    case "projection": {
      const state = await new JsonFileIndexerStore(dir).read();
      if (!state) {
        io.err(`no indexer state at ${dir}`);
        return 1;
      }
      const finalizedHeight = state.cursors.finalizedHead ? BigInt(state.cursors.finalizedHead.height) : -1n;
      const proj = buildProjection(state.journal, { finalizedHeight, reducerVersion: state.config.reducerVersion });
      if (parsed.command === "projection") {
        io.out(JSON.stringify(proj));
      } else {
        io.out(JSON.stringify({ command: "replay", status: state.health.status, digest: proj.digest, battles: Object.keys(proj.battles).length, finalizedHeight: proj.finalizedHeight }));
      }
      return exitForHealth(state.health.status);
    }
    default:
      io.err("usage: indexer <import|status|replay|projection> [--dir <state>] [--chain <file.json>]");
      return 1;
  }
}

const invokedDirectly = (() => {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runIndexerCli(argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
