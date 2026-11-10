import { toHex } from "./evm-abi.js";
import { errorMessage, silentLogger, type Logger } from "./logger.js";
import type { Hash, PayoutChainReader, PayoutReconciler } from "./payout-reconciler.js";
import type { PayoutView } from "./payout-status.js";

/**
 * Signature-initiation worker of the relayer role (OpenSpec arena-chain-signatures, issue #150).
 *
 * Each pass first reconciles every open payout against the chain (`PayoutReconciler`: rebroadcast of the
 * stored signed transaction, broadcast/pending bookkeeping, holds), and only then asks the contract for a
 * signature, and only for a payout that
 *  - is `authorized`, non-terminal and has no attempt at all,
 *  - names this deployment's source chain and a positive amount,
 *  - the reconciler has cleared this pass (`spendAllowed`: no transaction of it can still execute).
 * The relayer chooses only the fee cap. Everything else (destination, token, amount, nonce, path) is
 * built by the contract from the reservation, so this process cannot redirect a payout.
 *
 * Restart safety comes from contract state, not from memory: `request_signature` writes the attempt before
 * the signer call, so after a crash or a lost response the payout is `signing_requested` and no longer
 * eligible. This worker never retries a request in the same pass and never allocates a second spend for an
 * ambiguous one; a stuck request is held by the reconciler (`SignerNoResponse`) and resolved there.
 */
export interface SignatureRequester {
  requestSignature(payout: PayoutView, maxFeePerGas: bigint): Promise<void>;
}

export interface PayoutRelayerOptions {
  /** Source chain every payout of this deployment must name. */
  chainId: bigint;
  /** Fee cap sent with the first request. The contract still enforces its own registered limit. */
  maxFeePerGas: bigint;
  log?: Logger;
  now?: () => number;
}

export interface RelayerReport {
  requested: number;
  /** Authorized payouts that were not eligible this pass, with the reason (also logged). */
  skipped: Array<{ requestId: string; reason: string }>;
  errors: number;
  /** Set when the reconcile step failed: no signature was requested this pass. */
  reconcileError?: string;
}

export interface RelayerStatus {
  role: "relayer";
  lastPassAt: string | null;
  lastReport: RelayerReport | null;
}

const hex = (h: Hash): string => toHex(Uint8Array.from(h));
const ZERO20 = (h: number[]): boolean => h.every((b) => b === 0);

export class PayoutRelayer {
  private readonly log: Logger;
  private readonly now: () => number;
  private lastPassAt: number | null = null;
  private lastReport: RelayerReport | null = null;

  constructor(
    private readonly reconciler: Pick<PayoutReconciler, "reconcile" | "spendAllowed">,
    private readonly ledger: { listOpenPayouts(): Promise<PayoutView[]> },
    private readonly signer: SignatureRequester,
    private readonly chain: Pick<PayoutChainReader, "getTransactionCount">,
    private readonly opts: PayoutRelayerOptions,
  ) {
    if (opts.maxFeePerGas <= 0n) throw new Error("maxFeePerGas must be positive");
    this.log = opts.log ?? silentLogger;
    this.now = opts.now ?? Date.now;
  }

  status(): RelayerStatus {
    return {
      role: "relayer",
      lastPassAt: this.lastPassAt === null ? null : new Date(this.lastPassAt).toISOString(),
      lastReport: this.lastReport,
    };
  }

  private async ineligible(p: PayoutView): Promise<string | null> {
    if (p.state !== "authorized") return null; // not ours to start; the reconciler owns every other state
    if (p.terminal) return "terminal";
    if (p.attempts.length > 0) return "already has attempts";
    if (BigInt(p.chain_id) !== this.opts.chainId) return `payout chain ${p.chain_id} differs from configured ${this.opts.chainId}`;
    if (BigInt(p.amount) <= 0n) return "non-positive amount";
    if (ZERO20(p.destination) || ZERO20(p.token) || ZERO20(p.sender)) return "zero address in payout binding";
    if (!this.reconciler.spendAllowed(p.backing, p.holder, p.request_id)) return "not cleared by reconciliation this pass";
    // A signed transfer for a nonce the custody sender already used can never execute as authorized; hold it
    // for the operator instead of creating a signature the chain will reject or a foreign tx may precede.
    const next = await this.chain.getTransactionCount(toHex(Uint8Array.from(p.sender)), "pending");
    if (next > BigInt(p.nonce)) return `nonce ${p.nonce} of the custody sender is already used (count ${next}); operator proof needed`;
    return null;
  }

  async pass(): Promise<RelayerReport> {
    const report: RelayerReport = { requested: 0, skipped: [], errors: 0 };
    try {
      const reconciled = await this.reconciler.reconcile();
      report.errors += reconciled.errors;
    } catch (err) {
      // Fail closed: without a reconciliation nothing may create a spend.
      report.errors++;
      report.reconcileError = errorMessage(err);
      this.log.error("payout relayer: reconciliation failed, no signature requested", { error: report.reconcileError });
      return this.finish(report);
    }
    let payouts: PayoutView[];
    try {
      payouts = await this.ledger.listOpenPayouts();
    } catch (err) {
      report.errors++;
      this.log.error("payout relayer: could not list payouts", { error: errorMessage(err) });
      return this.finish(report);
    }
    for (const p of payouts) {
      if (p.state !== "authorized") continue;
      const requestId = hex(p.request_id);
      let reason: string | null;
      try {
        reason = await this.ineligible(p);
      } catch (err) {
        report.errors++;
        this.log.error("payout relayer: eligibility check failed, no signature requested", { requestId, error: errorMessage(err) });
        continue;
      }
      if (reason) {
        report.skipped.push({ requestId, reason });
        this.log.warn("payout relayer: authorized payout not eligible", { backing: p.backing, holder: p.holder, requestId, reason });
        continue;
      }
      try {
        await this.signer.requestSignature(p, this.opts.maxFeePerGas);
        report.requested++;
        this.log.info("payout relayer: signature requested", {
          backing: p.backing,
          holder: p.holder,
          requestId,
          chainId: p.chain_id,
          amount: p.amount,
          maxFeePerGas: this.opts.maxFeePerGas.toString(),
        });
      } catch (err) {
        // Ambiguous (the call may have landed): contract state decides next pass; never retried here.
        report.errors++;
        this.log.error("payout relayer: signature request failed or unconfirmed", { backing: p.backing, holder: p.holder, requestId, error: errorMessage(err) });
      }
    }
    return this.finish(report);
  }

  private finish(report: RelayerReport): RelayerReport {
    this.lastPassAt = this.now();
    this.lastReport = report;
    return report;
  }
}
