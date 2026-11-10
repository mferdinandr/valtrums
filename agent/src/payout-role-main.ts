import { fileURLToPath } from "node:url";
import { abortableSleep } from "./loop.js";
import { createJsonLogger, errorMessage } from "./logger.js";
import { loadPayoutRoleConfig, type PayoutRole } from "./payout-roles.js";
import { createOperator, createRelayer, loadOperatorSettings, loadRelayerSettings } from "./payout-role-wiring.js";

/**
 * Entry point of the two payout worker roles, one role per process:
 *   node dist/payout-role-main.js relayer   signature requests + reconciliation (PAYOUT_RELAYER_* credentials)
 *   node dist/payout-role-main.js operator  finalized-evidence confirm/revert/restore (PAYOUT_OPERATOR_* credentials)
 * Neither reads the other role's credentials or the arena agent key. See agent/README.md (Payout roles).
 */
export async function runRole(role: PayoutRole, env: NodeJS.ProcessEnv, stop: AbortSignal): Promise<void> {
  const log = createJsonLogger();
  const cfg = loadPayoutRoleConfig(role, env);
  // Only non-secret settings are logged.
  const run =
    role === "RELAYER"
      ? (() => {
          const settings = loadRelayerSettings(env);
          const worker = createRelayer(cfg, settings, log);
          log.info("payout relayer starting", { contract: cfg.payoutContractId, account: cfg.accountId, chainId: cfg.chainId.toString() });
          return async () => log.info("payout relayer pass", { ...(await worker.pass()) });
        })()
      : (() => {
          const settings = loadOperatorSettings(env);
          const worker = createOperator(cfg, settings, log);
          log.info("payout operator starting", { contract: cfg.payoutContractId, account: cfg.accountId, chainId: cfg.chainId.toString(), submit: settings.submit });
          if (!settings.submit) log.warn("payout operator is in dry-run mode: proofs are checked and logged, nothing is submitted (set PAYOUT_OPERATOR_SUBMIT=true)");
          return async () => log.info("payout operator pass", { ...(await worker.pass()) });
        })();
  while (!stop.aborted) {
    try {
      await run();
    } catch (err) {
      log.error("payout role pass failed", { role, error: errorMessage(err) });
    }
    await abortableSleep(cfg.intervalSecs * 1000, stop);
  }
}

const invokedDirectly = (() => {
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const arg = process.argv[2];
  if (arg !== "relayer" && arg !== "operator") {
    console.error("usage: payout-role-main.js <relayer|operator>");
    process.exit(1);
  }
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort());
  runRole(arg === "relayer" ? "RELAYER" : "OPERATOR", process.env, stop.signal).catch((err) => {
    console.error(JSON.stringify({ level: "fatal", msg: errorMessage(err) }));
    process.exitCode = 1;
  });
}
