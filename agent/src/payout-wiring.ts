import type { AgentConfig } from "./config.js";
import { FetchEvmRpc } from "./evm-rpc.js";
import type { Logger } from "./logger.js";
import { NearPayoutLedger } from "./near-payout-client.js";
import { createNearTransport } from "./near-client.js";
import { PayoutReconciler } from "./payout-reconciler.js";

export interface PayoutReconcileConfig {
  contractId: string;
  evmRpcUrl: string;
  signingGraceMs: number;
}

/**
 * Off unless `PAYOUT_RECONCILE_ENABLED=true`. The agent account acts as the
 * payout relayer, so it must be the relayer fixed at the payout contract's
 * initialization (an assumption to confirm per deployment).
 *
 * Owner decision: this worker never holds the operator key. Startup fails
 * closed (throws) when `PAYOUT_OPERATOR_ACCOUNT_ID` or
 * `PAYOUT_OPERATOR_PRIVATE_KEY` is set, whether or not reconciliation is
 * enabled, so the variables can never be silently ignored.
 */
export function loadPayoutReconcileConfig(
  env: Record<string, string | undefined> = process.env,
): PayoutReconcileConfig | null {
  for (const name of ["PAYOUT_OPERATOR_ACCOUNT_ID", "PAYOUT_OPERATOR_PRIVATE_KEY"]) {
    if (env[name] !== undefined && env[name] !== "") {
      throw new Error(`${name} is not supported: the reconciler never holds the operator key; remove it`);
    }
  }
  if (env.PAYOUT_RECONCILE_ENABLED?.trim() !== "true") return null;
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`missing required environment variable ${name}`);
    return v;
  };
  const contractId = need("PAYOUT_CONTRACT_ID");
  const evmRpcUrl = need("PAYOUT_EVM_RPC_URL");
  if (!/^https:\/\//.test(evmRpcUrl)) throw new Error("PAYOUT_EVM_RPC_URL must be an https URL");
  const grace = Number(env.PAYOUT_SIGNING_GRACE_SECS?.trim() || "300");
  if (!Number.isInteger(grace) || grace < 30) throw new Error("PAYOUT_SIGNING_GRACE_SECS must be an integer of at least 30");
  return {
    contractId,
    evmRpcUrl,
    signingGraceMs: grace * 1000,
  };
}

export function createPayoutReconciler(
  cfg: PayoutReconcileConfig,
  agent: AgentConfig,
  log: Logger,
): PayoutReconciler {
  const relayer = createNearTransport(agent);
  return new PayoutReconciler(
    new NearPayoutLedger(cfg.contractId, relayer),
    new FetchEvmRpc(cfg.evmRpcUrl),
    { signingGraceMs: cfg.signingGraceMs, log },
  );
}
