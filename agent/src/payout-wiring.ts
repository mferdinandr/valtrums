import type { AgentConfig } from "./config.js";
import { FetchEvmRpc } from "./evm-rpc.js";
import type { Logger } from "./logger.js";
import { NearPayoutLedger } from "./near-payout-client.js";
import { createNearTransport } from "./near-client.js";
import { PayoutReconciler } from "./payout-reconciler.js";

export interface PayoutReconcileConfig {
  contractId: string;
  evmRpcUrl: string;
  /** Operator account and key; without them confirm, revert and restore are reported, not sent. */
  operator?: { accountId: string; privateKey: string };
  signingGraceMs: number;
}

/**
 * Off unless `PAYOUT_RECONCILE_ENABLED=true`. The agent account acts as the
 * payout relayer, so it must be the relayer fixed at the payout contract's
 * initialization (an assumption to confirm per deployment).
 */
export function loadPayoutReconcileConfig(
  env: Record<string, string | undefined> = process.env,
): PayoutReconcileConfig | null {
  if (env.PAYOUT_RECONCILE_ENABLED?.trim() !== "true") return null;
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`missing required environment variable ${name}`);
    return v;
  };
  const contractId = need("PAYOUT_CONTRACT_ID");
  const evmRpcUrl = need("PAYOUT_EVM_RPC_URL");
  if (!/^https:\/\//.test(evmRpcUrl)) throw new Error("PAYOUT_EVM_RPC_URL must be an https URL");
  const operatorId = env.PAYOUT_OPERATOR_ACCOUNT_ID?.trim();
  const operatorKey = env.PAYOUT_OPERATOR_PRIVATE_KEY?.trim();
  if (Boolean(operatorId) !== Boolean(operatorKey)) {
    throw new Error("set both PAYOUT_OPERATOR_ACCOUNT_ID and PAYOUT_OPERATOR_PRIVATE_KEY, or neither");
  }
  if (operatorKey && !operatorKey.startsWith("ed25519:")) {
    throw new Error("the operator private key must be an ed25519:... key");
  }
  const grace = Number(env.PAYOUT_SIGNING_GRACE_SECS?.trim() || "300");
  if (!Number.isInteger(grace) || grace < 30) throw new Error("PAYOUT_SIGNING_GRACE_SECS must be an integer of at least 30");
  return {
    contractId,
    evmRpcUrl,
    ...(operatorId && operatorKey ? { operator: { accountId: operatorId, privateKey: operatorKey } } : {}),
    signingGraceMs: grace * 1000,
  };
}

export function createPayoutReconciler(
  cfg: PayoutReconcileConfig,
  agent: AgentConfig,
  log: Logger,
): PayoutReconciler {
  const relayer = createNearTransport(agent);
  const operator = cfg.operator
    ? createNearTransport({
        ...agent,
        agentAccountId: cfg.operator.accountId,
        agentPrivateKey: cfg.operator.privateKey,
      })
    : undefined;
  return new PayoutReconciler(
    new NearPayoutLedger(cfg.contractId, relayer, operator),
    new FetchEvmRpc(cfg.evmRpcUrl),
    { signingGraceMs: cfg.signingGraceMs, log },
  );
}
