import { toHex } from "./evm-abi.js";
import { errorMessage, silentLogger, type Logger } from "./logger.js";
import {
  evidenceHash,
  type Hash,
  type NoSpendProofInput,
  type OperatorProof,
  type PaymentEvidenceInput,
  type PayoutOutcome,
  type PayoutReconciler,
} from "./payout-reconciler.js";
import type { PayoutView } from "./payout-status.js";

/**
 * Finality-confirmation worker of the operator role (OpenSpec arena-chain-signatures, issue #150).
 *
 * It runs in its own process with its own account, key and source-chain RPC. Each pass it reconciles from
 * its own reads (a `PayoutReconciler` over a ledger that cannot write relayer methods) and receives the
 * `needs_operator` findings, each carrying the exact operator calls and the finalized chain facts. Before
 * any call it re-checks the proof against the payout's own contract view:
 *  - `confirm_payout`: evidence names this payout's chain, token, sender, destination and amount, the
 *    transaction is one of its recorded attempts, the evidence hash recomputes, and the payout is in a
 *    state that can still be confirmed (never authorized, terminal or held by another reason);
 *  - `record_revert`: the hash is one of the payout's recorded attempts;
 *  - `restore_payout`: names this payout's sender and chain, the nonce slot is finalized past the payout
 *    nonce, the cited reverted transaction is a recorded attempt, and every attempt is reverted or is
 *    recorded as reverted by the calls before it in the same proof.
 * A mismatch is refused and reported; it is never submitted. The contract re-checks everything on chain,
 * so this is a second, independent gate, not the only one.
 *
 * Nothing is submitted unless `submit` is true: a dry run logs the proofs and returns them. A client
 * timeout or a failed call never changes liability: the payout stays open and the next pass reads the
 * chain again.
 */
export interface OperatorSubmitter {
  confirmPayout(p: PayoutView, evidence: PaymentEvidenceInput): Promise<void>;
  recordRevert(p: PayoutView, txHash: Hash): Promise<void>;
  restorePayout(p: PayoutView, proof: NoSpendProofInput): Promise<void>;
}

export interface PayoutOperatorOptions {
  /** Without this the operator only reports what it would submit. */
  submit: boolean;
  log?: Logger;
  now?: () => number;
}

export type OperatorResult =
  | { kind: "submitted"; requestId: string; calls: string[] }
  | { kind: "dry_run"; requestId: string; calls: string[] }
  | { kind: "refused"; requestId: string; reason: string }
  | { kind: "failed"; requestId: string; reason: string; submitted: string[] };

export interface OperatorReport {
  results: OperatorResult[];
  /** Open payouts the reconciliation left unresolved (informational). */
  unresolved: number;
  errors: number;
  reconcileError?: string;
}

export interface OperatorStatus {
  role: "operator";
  submit: boolean;
  lastPassAt: string | null;
  lastReport: OperatorReport | null;
}

const hex = (h: Hash): string => toHex(Uint8Array.from(h));
const same = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const keyOf = (p: { backing: string; holder: string; request_id: Hash }): string => `${p.backing}|${p.holder}|${hex(p.request_id)}`;

/** Independent check of an `OperatorProof` against the contract's own view of the payout. Returns a reason to refuse, or null. */
export function checkOperatorProof(p: PayoutView, proof: OperatorProof): string | null {
  if (p.terminal) return "payout is already terminal";
  if (proof.calls.length === 0) return "proof has no calls";
  const recorded = (h: Hash): boolean => p.attempts.some((a) => same(a.tx_hash, h));
  // Attempts that are reverted on chain by the time the restore runs: already recorded, or recorded by an earlier call.
  const reverted = new Set(p.attempts.filter((a) => a.state === "reverted").map((a) => hex(a.tx_hash)));
  for (const [i, call] of proof.calls.entries()) {
    switch (call.method) {
      case "confirm_payout": {
        const e = call.evidence;
        if (proof.calls.length !== 1) return "confirm_payout must stand alone";
        if (p.state !== "pending_finality" && p.state !== "broadcast") return `payout is ${p.state}, not confirmable`;
        if (e.chain_id !== p.chain_id) return "evidence chain differs from the payout";
        if (!same(e.token, p.token) || !same(e.sender, p.sender) || !same(e.recipient, p.destination)) {
          return "evidence token/sender/recipient differs from the payout binding";
        }
        if (BigInt(e.amount) !== BigInt(p.amount)) return "evidence amount differs from the payout amount";
        if (!recorded(e.tx_hash)) return "evidence transaction is not a recorded attempt of this payout";
        if (BigInt(e.block_number) > BigInt(e.finalized_head_number)) return "evidence block is above the finalized head";
        const { evidence_hash: claimed, ...base } = e;
        if (!same(claimed, evidenceHash(base))) return "evidence hash does not recompute";
        break;
      }
      case "record_revert":
        if (!recorded(call.tx_hash)) return "reverted transaction is not a recorded attempt of this payout";
        reverted.add(hex(call.tx_hash));
        break;
      case "restore_payout": {
        const r = call.proof;
        if (i !== proof.calls.length - 1) return "restore_payout must be the last call";
        if (r.chain_id !== p.chain_id || !same(r.sender, p.sender)) return "no-spend proof names another chain or sender";
        if (BigInt(r.finalized_nonce) <= BigInt(p.nonce)) return "payout nonce slot is not finalized";
        if (!recorded(r.outcome.OurTxReverted)) return "cited reverted transaction is not a recorded attempt";
        if (p.attempts.some((a) => !reverted.has(hex(a.tx_hash)))) return "an attempt of this payout is not proven reverted";
        break;
      }
    }
  }
  return null;
}

export class PayoutOperator {
  private readonly log: Logger;
  private readonly now: () => number;
  private lastPassAt: number | null = null;
  private lastReport: OperatorReport | null = null;

  constructor(
    private readonly reconciler: Pick<PayoutReconciler, "reconcile">,
    private readonly ledger: { listOpenPayouts(): Promise<PayoutView[]> },
    private readonly submitter: OperatorSubmitter,
    private readonly opts: PayoutOperatorOptions,
  ) {
    this.log = opts.log ?? silentLogger;
    this.now = opts.now ?? Date.now;
  }

  status(): OperatorStatus {
    return {
      role: "operator",
      submit: this.opts.submit,
      lastPassAt: this.lastPassAt === null ? null : new Date(this.lastPassAt).toISOString(),
      lastReport: this.lastReport,
    };
  }

  async pass(): Promise<OperatorReport> {
    const report: OperatorReport = { results: [], unresolved: 0, errors: 0 };
    let outcomes: PayoutOutcome[];
    try {
      const reconciled = await this.reconciler.reconcile();
      outcomes = reconciled.outcomes;
      report.unresolved = reconciled.unresolved;
      report.errors += reconciled.errors;
    } catch (err) {
      report.errors++;
      report.reconcileError = errorMessage(err);
      this.log.error("payout operator: reconciliation failed, nothing submitted", { error: report.reconcileError });
      return this.finish(report);
    }
    const findings = outcomes.filter((o) => o.kind === "needs_operator" && o.proof);
    if (findings.length === 0) return this.finish(report);
    let live: Map<string, PayoutView>;
    try {
      live = new Map((await this.ledger.listOpenPayouts()).map((p) => [keyOf(p), p]));
    } catch (err) {
      report.errors++;
      this.log.error("payout operator: could not read payouts", { error: errorMessage(err) });
      return this.finish(report);
    }
    for (const o of findings) {
      const result = await this.handle(o, live.get(`${o.backing}|${o.holder}|${o.requestId}`));
      if (result.kind === "refused" || result.kind === "failed") report.errors++;
      report.results.push(result);
    }
    return this.finish(report);
  }

  private async handle(o: PayoutOutcome, payout: PayoutView | undefined): Promise<OperatorResult> {
    const requestId = o.requestId;
    const proof = o.proof as OperatorProof;
    const calls = proof.calls.map((c) => c.method);
    if (!payout) return this.refuse(requestId, "payout is no longer open");
    const refusal = checkOperatorProof(payout, proof);
    if (refusal) return this.refuse(requestId, refusal);
    if (!this.opts.submit) {
      this.log.warn("payout operator: dry run, proof checked but not submitted", { backing: o.backing, holder: o.holder, requestId, calls, facts: proof.facts });
      return { kind: "dry_run", requestId, calls };
    }
    const done: string[] = [];
    for (const call of proof.calls) {
      try {
        if (call.method === "confirm_payout") await this.submitter.confirmPayout(payout, call.evidence);
        else if (call.method === "record_revert") await this.submitter.recordRevert(payout, call.tx_hash);
        else await this.submitter.restorePayout(payout, call.proof);
        done.push(call.method);
      } catch (err) {
        // The call may or may not have landed; the payout stays open and the next pass reads the chain again.
        const reason = errorMessage(err);
        this.log.error("payout operator: call failed or unconfirmed, payout left open", { backing: o.backing, holder: o.holder, requestId, method: call.method, submitted: done, error: reason });
        return { kind: "failed", requestId, reason, submitted: done };
      }
    }
    this.log.info("payout operator: submitted", { backing: o.backing, holder: o.holder, requestId, calls: done, facts: proof.facts });
    return { kind: "submitted", requestId, calls: done };
  }

  private refuse(requestId: string, reason: string): OperatorResult {
    this.log.error("payout operator: proof refused, nothing submitted", { requestId, reason });
    return { kind: "refused", requestId, reason };
  }

  private finish(report: OperatorReport): OperatorReport {
    this.lastPassAt = this.now();
    this.lastReport = report;
    return report;
  }
}
