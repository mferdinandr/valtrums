import { fileURLToPath } from "node:url";
import { Near } from "near-kit";
import { createJsonLogger, errorMessage } from "../logger.js";
import { VersionedLifecycleReadSource } from "../mcp/application-adapter.js";
import type { NearTransport } from "../near-client.js";
import { loadObservationState } from "../observations/journal.js";
import { abortableSleep } from "../loop.js";
import { withViewRetries } from "../rpc-resilience.js";
import { loadOracleConfig, type OracleConfig } from "./config.js";
import { LifecycleOracle, type LifecycleViews } from "./driver.js";
import { OracleStateDir } from "./status.js";

/**
 * Entry point: `node dist/lifecycle-oracle/main.js` (pnpm lifecycle:oracle). A dedicated process with the
 * dedicated oracle account key only. Writes are off until ORACLE_WRITES_ENABLED=true. Provider sampling is
 * a separate concern: this process reads PERSISTED observation evidence (issue #146) and nothing else.
 */
export function createTransport(cfg: OracleConfig): NearTransport {
  const near = new Near({ network: cfg.network, rpcUrl: cfg.rpcUrl, privateKey: cfg.privateKey as `ed25519:${string}`, defaultSignerId: cfg.accountId });
  return withViewRetries({
    view: (contractId, method, args) => near.view(contractId, method, args),
    call: (contractId, method, args, gas, attachedDeposit) =>
      near.call(contractId, method, args, { gas: gas as never, signerId: cfg.accountId, ...(attachedDeposit ? { attachedDeposit: attachedDeposit as never } : {}) }),
  });
}

export async function runOracle(env: NodeJS.ProcessEnv, stop: AbortSignal): Promise<void> {
  const log = createJsonLogger();
  const cfg = loadOracleConfig(env);
  const tx = createTransport(cfg);
  const source = new VersionedLifecycleReadSource(cfg.arenaContractId, (c, m, a) => tx.view(c, m, a));
  const views: LifecycleViews = {
    count: () => source.count(),
    battle: (id) => source.battle(id),
    round: (id) => source.round(id),
    readiness: (id) => source.readiness(id),
  };
  const state = await OracleStateDir.open(cfg.stateDir);
  const oracle = new LifecycleOracle(cfg, { views, tx, state, log, loadEvidence: async () => (await loadObservationState(cfg.journalDir)).state });
  // Only non-secret settings are logged.
  log.info("lifecycle oracle starting", {
    contract: cfg.arenaContractId, account: cfg.accountId, network: cfg.network, writesEnabled: cfg.writesEnabled,
    evidenceKinds: [...cfg.evidenceKinds], qualifiedModes: [...cfg.qualifiedModes], termsConfigured: cfg.terms.size,
    roundsStorageDeposit: cfg.roundsStorageDepositYocto !== null,
  });
  if (!cfg.writesEnabled) log.warn("lifecycle oracle is in dry-run mode: it reads and reports, and sends nothing (set ORACLE_WRITES_ENABLED=true)");
  try {
    while (!stop.aborted) {
      try { await oracle.pass(); } catch (err) { log.error("lifecycle oracle pass failed", { error: errorMessage(err) }); }
      await abortableSleep(cfg.intervalSecs * 1000, stop);
    }
  } finally {
    await state.close();
  }
}

const invokedDirectly = (() => { try { return fileURLToPath(import.meta.url) === process.argv[1]; } catch { return false; } })();
if (invokedDirectly) {
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => stop.abort()); // not `once`: a repeated SIGTERM must not kill the process before the lock is released
  runOracle(process.env, stop.signal).catch((err) => {
    console.error(JSON.stringify({ level: "fatal", msg: errorMessage(err) }));
    process.exitCode = 1;
  });
}
