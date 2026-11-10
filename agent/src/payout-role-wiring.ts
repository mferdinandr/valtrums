import { FetchEvmRpc } from "./evm-rpc.js";
import type { Logger } from "./logger.js";
import { NearPayoutLedger, NearPayoutOperatorLedger, requestPayoutSignature } from "./near-payout-client.js";
import { PayoutOperator } from "./payout-operator.js";
import { PayoutReconciler, type Hash, type PayoutLedger } from "./payout-reconciler.js";
import { PayoutRelayer } from "./payout-relayer.js";
import { createRoleTransport, type PayoutRoleConfig } from "./payout-roles.js";
import type { PayoutHoldReason, PayoutView } from "./payout-status.js";

/** Settings only the relayer has. */
export interface RelayerSettings {
  maxFeePerGas: bigint;
  signingGraceMs: number;
}

/** Settings only the operator has. Submitting is opt-in: without it the operator checks and reports proofs. */
export interface OperatorSettings {
  submit: boolean;
}

export function loadRelayerSettings(env: Record<string, string | undefined> = process.env): RelayerSettings {
  const fee = env.PAYOUT_RELAYER_MAX_FEE_PER_GAS_WEI?.trim();
  if (!fee || !/^[1-9][0-9]*$/.test(fee)) throw new Error("PAYOUT_RELAYER_MAX_FEE_PER_GAS_WEI must be a positive integer (wei)");
  const grace = Number(env.PAYOUT_SIGNING_GRACE_SECS?.trim() || "300");
  if (!Number.isInteger(grace) || grace < 30) throw new Error("PAYOUT_SIGNING_GRACE_SECS must be an integer of at least 30");
  return { maxFeePerGas: BigInt(fee), signingGraceMs: grace * 1000 };
}

export function loadOperatorSettings(env: Record<string, string | undefined> = process.env): OperatorSettings {
  const v = env.PAYOUT_OPERATOR_SUBMIT?.trim();
  if (v !== undefined && v !== "" && v !== "true" && v !== "false") throw new Error('PAYOUT_OPERATOR_SUBMIT must be "true" or "false"');
  return { submit: v === "true" };
}

/** A ledger for the operator's reconciler: reads work, relayer writes are refused loudly (the operator role never holds them). */
class ReadOnlyLedger implements PayoutLedger {
  constructor(private readonly inner: PayoutLedger) {}
  listOpenPayouts(): Promise<PayoutView[]> {
    return this.inner.listOpenPayouts();
  }
  getSignedTransaction(p: PayoutView, h: Hash): Promise<string | null> {
    return this.inner.getSignedTransaction(p, h);
  }
  private refuse(method: string): never {
    throw new Error(`${method} is a relayer method; the operator process does not hold the relayer role`);
  }
  recordBroadcast(): Promise<void> {
    return this.refuse("record_broadcast");
  }
  recordPendingFinality(): Promise<void> {
    return this.refuse("record_pending_finality");
  }
  requireReconciliation(_p: PayoutView, _reason: PayoutHoldReason): Promise<void> {
    return this.refuse("require_reconciliation");
  }
}

export function createRelayer(cfg: PayoutRoleConfig, settings: RelayerSettings, log: Logger): PayoutRelayer {
  const transport = createRoleTransport(cfg);
  const ledger = new NearPayoutLedger(cfg.payoutContractId, transport);
  const evm = new FetchEvmRpc(cfg.evmRpcUrl);
  const reconciler = new PayoutReconciler(ledger, evm, { signingGraceMs: settings.signingGraceMs, log });
  return new PayoutRelayer(
    reconciler,
    ledger,
    { requestSignature: (p, fee) => requestPayoutSignature(transport, cfg.payoutContractId, p, fee) },
    evm,
    { chainId: cfg.chainId, maxFeePerGas: settings.maxFeePerGas, log },
  );
}

export function createOperator(cfg: PayoutRoleConfig, settings: OperatorSettings, log: Logger): PayoutOperator {
  const ledger = new NearPayoutOperatorLedger(cfg.payoutContractId, createRoleTransport(cfg));
  const reconciler = new PayoutReconciler(new ReadOnlyLedger(ledger.reads), new FetchEvmRpc(cfg.evmRpcUrl), { log });
  return new PayoutOperator(reconciler, ledger.reads, ledger, { submit: settings.submit, log });
}
