import { TRANSFER_TOPIC, decodeUintWord, fromHex, keccak, normalizeAddress, toHex } from "./evm-abi.js";
import type { EvmLog, EvmReceipt } from "./evm-rpc.js";
import { decodeTx, txHash } from "./evm-tx.js";
import { encodeTransfer } from "./evm-abi.js";
import { type Logger, errorMessage, silentLogger } from "./logger.js";
import type { PayoutAttemptView, PayoutHoldReason, PayoutView } from "./payout-status.js";

/**
 * Restart reconciliation of payouts (OpenSpec arena-chain-signatures, issue #64).
 *
 * After a restart or a lost response the worker reads every open payout from
 * the payout contract, compares each recorded attempt with the source chain and
 * moves the contract to what the chain proves. It never requests a signature
 * and never creates a spend. `spendAllowed` is the gate for any code that does:
 * it is true only for a payout this process reconciled and found to have no
 * transaction that could still execute.
 *
 * Authority stays with the contract roles. The relayer ledger methods
 * (`recordBroadcast`, `recordPendingFinality`, `requireReconciliation`) are
 * required; the operator methods (`recordRevert`, `confirmPayout`,
 * `restorePayout`) are optional and, when absent, the outcome is
 * `needs_operator` instead of an action. Evidence is the worker's own read of
 * finalized chain state, a trusted attestation like deposits, not a proof.
 */

export type Hash = number[];

/** Wire shape of `confirm_payout`'s evidence argument. */
export interface PaymentEvidenceInput {
  chain_id: string;
  token: number[];
  sender: number[];
  recipient: number[];
  amount: string;
  tx_hash: Hash;
  log_index: number;
  block_hash: Hash;
  block_number: string;
  finalized_head_number: string;
  finalized_head_hash: Hash;
  evidence_hash: Hash;
}

/** Wire shape of `restore_payout`'s proof argument (only the reverted-attempt outcome is built here). */
export interface NoSpendProofInput {
  chain_id: string;
  sender: number[];
  finalized_nonce: string;
  outcome: { OurTxReverted: Hash };
  finalized_head_number: string;
  finalized_head_hash: Hash;
}

/** Contract surface the reconciler uses. All writes carry the contract's one-yocto rule inside the implementation. */
export interface PayoutLedger {
  /** Every non-terminal payout, all pages, creation order. */
  listOpenPayouts(): Promise<PayoutView[]>;
  /** Hex (no 0x) of the stored signed transaction of an attempt, or null. */
  getSignedTransaction(payout: PayoutView, txHash: Hash): Promise<string | null>;
  // Relayer
  recordBroadcast(payout: PayoutView, txHash: Hash): Promise<void>;
  recordPendingFinality(payout: PayoutView, txHash: Hash): Promise<void>;
  requireReconciliation(payout: PayoutView, reason: PayoutHoldReason): Promise<void>;
  // Operator (optional)
  recordRevert?(payout: PayoutView, txHash: Hash): Promise<void>;
  confirmPayout?(payout: PayoutView, evidence: PaymentEvidenceInput): Promise<void>;
  restorePayout?(payout: PayoutView, proof: NoSpendProofInput): Promise<void>;
}

/** Source-chain reads and the one write (rebroadcast of an already signed transaction). */
export interface PayoutChainReader {
  chainId(): Promise<bigint>;
  getFinalizedBlock(): Promise<{ number: bigint; hash: string }>;
  getBlockHash(number: bigint): Promise<string | null>;
  getTransactionCount(address: string, tag: "pending" | "latest" | "finalized"): Promise<bigint>;
  getTransactionReceipt(hash: string): Promise<EvmReceipt | null>;
  isTransactionKnown(hash: string): Promise<boolean>;
  sendRawTransaction(rawHex: string): Promise<string>;
}

export type OutcomeKind =
  /** Nothing was signed or sent; nothing to reconcile. */
  | "idle"
  /** A transaction is in flight or a signer answer is awaited. */
  | "waiting"
  /** The contract was moved towards a state the chain proves (broadcast, pending). */
  | "progressed"
  | "rebroadcast"
  | "confirmed"
  | "reverted"
  | "restored"
  /** Held for reconciliation; the reservation stays. */
  | "held"
  /** The chain proves something only the operator role may record. */
  | "needs_operator"
  | "error";

export interface PayoutOutcome {
  backing: string;
  holder: string;
  requestId: string;
  state: string;
  kind: OutcomeKind;
  detail: string;
  /** True only when no transaction of this payout can still execute. */
  spendAllowed: boolean;
}

export interface ReconcileReport {
  outcomes: PayoutOutcome[];
  /** Payouts that still block a new spend. */
  unresolved: number;
  errors: number;
}

export interface PayoutReconcilerOptions {
  /** Blocks are final only through the node's `finalized` tag; no extra depth is invented. */
  /** How long a `signing_requested` payout may wait in this process before it is held. */
  signingGraceMs?: number;
  now?: () => number;
  log?: Logger;
}

const ZERO = (h: number[]): boolean => h.every((b) => b === 0);
const hex = (h: number[]): string => toHex(Uint8Array.from(h));
const bytes = (hexText: string): number[] => [...fromHex(hexText)];
const keyOf = (p: PayoutView): string => `${p.backing}|${p.holder}|${hex(p.request_id)}`;

function u64Be(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n);
  return out;
}

/**
 * Hash that names an accepted piece of evidence: keccak256 over chain id, tx
 * hash, block hash, log index, token, sender, recipient and amount. The
 * contract only requires it to be non-zero and equal on a repeat; this is the
 * worker's own convention.
 */
export function evidenceHash(e: Omit<PaymentEvidenceInput, "evidence_hash">): Hash {
  const amount = new Uint8Array(16);
  const view = new DataView(amount.buffer);
  const a = BigInt(e.amount);
  view.setBigUint64(0, a >> 64n);
  view.setBigUint64(8, a & 0xffff_ffff_ffff_ffffn);
  const log = new Uint8Array(4);
  new DataView(log.buffer).setUint32(0, e.log_index);
  const parts = [
    u64Be(BigInt(e.chain_id)),
    Uint8Array.from(e.tx_hash),
    Uint8Array.from(e.block_hash),
    log,
    Uint8Array.from(e.token),
    Uint8Array.from(e.sender),
    Uint8Array.from(e.recipient),
    amount,
  ];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return [...keccak(all)];
}

const sameBytes = (a: Uint8Array, b: number[]): boolean => a.length === b.length && b.every((x, i) => x === a[i]);

/** The Transfer log of the exact payment (token contract, sender, recipient, amount), if any. */
function findTransfer(receipt: EvmReceipt, p: PayoutView): EvmLog | null {
  const token = Uint8Array.from(p.token);
  const amount = BigInt(p.amount);
  for (const log of receipt.logs) {
    if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    try {
      if (!sameBytes(fromHex(normalizeAddress(log.address)), [...token])) continue;
      const from = fromHex(log.topics[1] as string).slice(12);
      const to = fromHex(log.topics[2] as string).slice(12);
      if (!sameBytes(from, p.sender) || !sameBytes(to, p.destination)) continue;
      if (decodeUintWord(log.data) !== amount) continue;
      return log;
    } catch {
      // A malformed log never counts as evidence.
    }
  }
  return null;
}

interface Observation {
  attempt: PayoutAttemptView;
  hash: string;
  receipt: EvmReceipt | null;
  known: boolean;
}

export class PayoutReconciler {
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly signingGraceMs: number;
  /** First time this process saw a payout waiting for the signer. */
  private readonly signingSeen = new Map<string, number>();
  private readonly allowed = new Map<string, boolean>();
  private completed = false;

  constructor(
    private readonly ledger: PayoutLedger,
    private readonly chain: PayoutChainReader,
    opts: PayoutReconcilerOptions = {},
  ) {
    this.log = opts.log ?? silentLogger;
    this.now = opts.now ?? Date.now;
    this.signingGraceMs = opts.signingGraceMs ?? 5 * 60_000;
  }

  /**
   * Gate for spend-creating code. False before the first complete pass of this
   * process, for any payout the last pass could not clear, and for unknown
   * payouts' attempts alike. A payout that has no attempts at all and was seen
   * `authorized` is clear.
   */
  spendAllowed(backing: string, holder: string, requestId: Hash): boolean {
    return this.completed && this.allowed.get(`${backing}|${holder}|${hex(requestId)}`) === true;
  }

  /** Reads all open payouts and reconciles each one. Never throws for a single payout. */
  async reconcile(): Promise<ReconcileReport> {
    const payouts = await this.ledger.listOpenPayouts();
    const outcomes: PayoutOutcome[] = [];
    let ctx: { finalized: { number: bigint; hash: string } } | undefined;
    let ctxError: string | undefined;
    try {
      ctx = { finalized: await this.chain.getFinalizedBlock() };
    } catch (err) {
      ctxError = errorMessage(err);
    }
    const chainId = ctx ? await this.chain.chainId().catch(() => null) : null;
    this.allowed.clear();
    for (const p of payouts) {
      let outcome: PayoutOutcome;
      try {
        if (!ctx) throw new Error(`finalized head unavailable: ${ctxError}`);
        if (chainId === null || BigInt(p.chain_id) !== chainId) {
          throw new Error(`RPC chain id ${chainId} differs from payout chain ${p.chain_id}`);
        }
        outcome = await this.one(p, ctx.finalized);
      } catch (err) {
        outcome = this.make(p, "error", errorMessage(err), false);
      }
      this.allowed.set(keyOf(p), outcome.spendAllowed);
      outcomes.push(outcome);
      // The operator reads the agent's structured log: findings that need a person are warnings or errors.
      const level =
        outcome.kind === "error" ? "error" : outcome.kind === "held" || outcome.kind === "needs_operator" ? "warn" : "info";
      this.log[level]("payout reconciled", { ...outcome });
    }
    // A complete pass is one that listed the payouts; per-payout errors keep their own gate closed.
    this.completed = true;
    return {
      outcomes,
      unresolved: outcomes.filter((o) => !o.spendAllowed).length,
      errors: outcomes.filter((o) => o.kind === "error").length,
    };
  }

  private make(p: PayoutView, kind: OutcomeKind, detail: string, spendAllowed: boolean): PayoutOutcome {
    return {
      backing: p.backing,
      holder: p.holder,
      requestId: hex(p.request_id),
      state: p.state,
      kind,
      detail,
      spendAllowed,
    };
  }

  private async one(p: PayoutView, fin: { number: bigint; hash: string }): Promise<PayoutOutcome> {
    const key = keyOf(p);
    const live = p.attempts.filter((a) => !ZERO(a.tx_hash));
    const requested = p.attempts.some((a) => a.state === "requested");
    if (requested) {
      if (!this.signingSeen.has(key)) this.signingSeen.set(key, this.now());
    } else {
      this.signingSeen.delete(key);
    }

    if (live.length === 0) {
      if (requested) return this.waitForSigner(p, key);
      if (p.state === "authorized") return this.make(p, "idle", "no signature was ever requested", true);
      // Held or otherwise unresolved without a known transaction: the signer may still answer.
      return this.make(p, "held", "no recorded attempt; a late signature could still exist", false);
    }

    const obs: Observation[] = [];
    for (const attempt of live) {
      const hash = hex(attempt.tx_hash);
      const receipt = await this.chain.getTransactionReceipt(hash);
      const known = receipt ? true : await this.chain.isTransactionKnown(hash);
      obs.push({ attempt, hash, receipt, known });
    }

    // 1. A successful attempt: this is a spend and decides everything.
    const success = obs.find((o) => o.receipt?.status === true);
    if (success?.receipt) return this.onSuccess(p, success, fin);

    // 2. Attempts that finalized with failure.
    let revertedNow = 0;
    const needsOperator: string[] = [];
    for (const o of obs) {
      if (o.attempt.state === "reverted") continue;
      if (o.receipt && !o.receipt.status && o.receipt.blockNumber <= fin.number) {
        if (!(await this.isCanonical(o.receipt))) {
          return this.hold(p, "EvidenceUnavailable", `receipt block of ${o.hash} is not on the canonical chain`);
        }
        if (!this.ledger.recordRevert) {
          needsOperator.push(`record_revert ${o.hash}`);
          continue;
        }
        await this.ledger.recordRevert(p, o.attempt.tx_hash);
        revertedNow++;
      }
    }
    const finalFailed = (o: Observation): boolean =>
      o.attempt.state === "reverted" ||
      (o.receipt !== null && !o.receipt.status && o.receipt.blockNumber <= fin.number);
    if (obs.every(finalFailed)) {
      if (needsOperator.length > 0) {
        return this.make(p, "needs_operator", needsOperator.join("; "), false);
      }
      return this.afterReverts(p, obs, fin, revertedNow);
    }

    // 3. Something may still execute. Look at what the network knows.
    const open = obs.filter((o) => !finalFailed(o));
    const seen = open.filter((o) => o.known);
    if (seen.length > 0) {
      for (const o of seen) await this.ensureSeen(p, o);
      return this.make(p, "waiting", `${seen.length} attempt(s) on the network, not final`, false);
    }

    // No open attempt is known to the node. The slot decides whether the same transaction may be sent again.
    const nonce = BigInt(p.nonce);
    const pending = await this.chain.getTransactionCount(hex(p.sender), "pending");
    if (pending > nonce) {
      return this.hold(
        p,
        "EvidenceUnavailable",
        `nonce ${nonce} of the custody sender is used (count ${pending}) but no recorded attempt is on chain; operator proof needed`,
      );
    }
    return this.rebroadcast(p, open, requested);
  }

  private async waitForSigner(p: PayoutView, key: string): Promise<PayoutOutcome> {
    const since = this.signingSeen.get(key) ?? this.now();
    if (this.now() - since >= this.signingGraceMs && p.state === "signing_requested") {
      return this.hold(p, "SignerNoResponse", "signer answer not seen within the grace period; reservation held");
    }
    return this.make(p, "waiting", "waiting for the signer callback", false);
  }

  private async hold(p: PayoutView, reason: PayoutHoldReason, detail: string): Promise<PayoutOutcome> {
    if (p.state !== "reconciliation_required") {
      await this.ledger.requireReconciliation(p, reason);
    }
    return this.make(p, "held", `${reason}: ${detail}`, false);
  }

  private async isCanonical(receipt: EvmReceipt): Promise<boolean> {
    if (!receipt.blockHash) return false;
    const onChain = await this.chain.getBlockHash(receipt.blockNumber);
    return onChain !== null && onChain.toLowerCase() === receipt.blockHash.toLowerCase();
  }

  private async onSuccess(
    p: PayoutView,
    o: Observation,
    fin: { number: bigint; hash: string },
  ): Promise<PayoutOutcome> {
    const receipt = o.receipt as EvmReceipt;
    if (receipt.blockNumber > fin.number) {
      await this.ensureSeen(p, o);
      return this.make(p, "waiting", `${o.hash} succeeded in block ${receipt.blockNumber}, not final yet`, false);
    }
    if (!(await this.isCanonical(receipt))) {
      return this.hold(p, "EvidenceUnavailable", `receipt block of ${o.hash} is not on the canonical chain`);
    }
    const transfer = findTransfer(receipt, p);
    if (!transfer || transfer.logIndex === undefined || !receipt.blockHash) {
      // Partial, mismatched or unindexed evidence never confirms and never allows a second payment.
      return this.hold(p, "EvidenceUnavailable", `${o.hash} finalized without an exact matching transfer`);
    }
    if (!this.ledger.confirmPayout) {
      return this.make(p, "needs_operator", `confirm_payout with finalized receipt ${o.hash}`, false);
    }
    const base = {
      chain_id: p.chain_id,
      token: p.token,
      sender: p.sender,
      recipient: p.destination,
      amount: p.amount,
      tx_hash: o.attempt.tx_hash,
      log_index: transfer.logIndex,
      block_hash: bytes(receipt.blockHash),
      block_number: receipt.blockNumber.toString(),
      finalized_head_number: fin.number.toString(),
      finalized_head_hash: bytes(fin.hash),
    };
    await this.ledger.confirmPayout(p, { ...base, evidence_hash: evidenceHash(base) });
    return this.make(p, "confirmed", `confirmed with ${o.hash}`, false);
  }

  private async afterReverts(
    p: PayoutView,
    obs: Observation[],
    fin: { number: bigint; hash: string },
    revertedNow: number,
  ): Promise<PayoutOutcome> {
    const nonce = BigInt(p.nonce);
    const finalizedNonce = await this.chain.getTransactionCount(hex(p.sender), "finalized");
    if (finalizedNonce <= nonce) {
      return this.make(p, "waiting", "attempts reverted, nonce slot not finalized yet", false);
    }
    if (p.attempts.some((a) => a.state === "requested")) {
      return this.make(p, "waiting", "a signer answer is still outstanding", false);
    }
    const proofHash = (obs[0] as Observation).attempt.tx_hash;
    if (!this.ledger.restorePayout) {
      return this.make(p, "needs_operator", "restore_payout with a reverted-attempt proof", false);
    }
    await this.ledger.restorePayout(p, {
      chain_id: p.chain_id,
      sender: p.sender,
      finalized_nonce: finalizedNonce.toString(),
      outcome: { OurTxReverted: proofHash },
      finalized_head_number: fin.number.toString(),
      finalized_head_hash: bytes(fin.hash),
    });
    return this.make(
      p,
      "restored",
      `nonce slot ${nonce} finalized with ${revertedNow} revert(s) recorded now; liability restored`,
      false,
    );
  }

  /** Moves the contract's attempt state to what the network shows (relayer-allowed transitions only). */
  private async ensureSeen(p: PayoutView, o: Observation): Promise<void> {
    if (o.attempt.state === "signed") {
      await this.ledger.recordBroadcast(p, o.attempt.tx_hash);
      await this.ledger.recordPendingFinality(p, o.attempt.tx_hash);
    } else if (o.attempt.state === "broadcast") {
      await this.ledger.recordPendingFinality(p, o.attempt.tx_hash);
    }
  }

  /**
   * No attempt reached the network and the slot is free: send the highest-fee
   * signed attempt again, byte for byte. This is the same transaction, so it
   * cannot pay twice; a different or new transaction is never built here.
   */
  private async rebroadcast(p: PayoutView, open: Observation[], requested: boolean): Promise<PayoutOutcome> {
    const best = [...open].sort((a, b) => (BigInt(a.attempt.max_fee_per_gas) < BigInt(b.attempt.max_fee_per_gas) ? 1 : -1))[0];
    if (!best) return this.make(p, "held", "no signed attempt to send", false);
    const raw = await this.ledger.getSignedTransaction(p, best.attempt.tx_hash);
    if (!raw) return this.hold(p, "EvidenceUnavailable", `stored signed transaction of ${best.hash} is unavailable`);
    this.verifySigned(p, raw, best.hash);
    try {
      await this.chain.sendRawTransaction(`0x${raw.replace(/^0x/, "")}`);
    } catch (err) {
      // The node may have accepted it before failing: only a transaction it does not know is a failure.
      if (!(await this.chain.isTransactionKnown(best.hash))) {
        return this.make(p, "error", `rebroadcast of ${best.hash} failed: ${errorMessage(err)}`, false);
      }
    }
    if (best.attempt.state === "signed") await this.ledger.recordBroadcast(p, best.attempt.tx_hash);
    return this.make(
      p,
      "rebroadcast",
      `sent ${best.hash} again${requested ? "; a signer answer is still outstanding" : ""}`,
      false,
    );
  }

  /** The stored bytes must be exactly the transfer the payout is bound to. */
  private verifySigned(p: PayoutView, raw: string, expectedHash: string): void {
    const clean = raw.replace(/^0x/, "");
    if (txHash(clean).toLowerCase() !== expectedHash.toLowerCase()) {
      throw new Error("stored signed transaction does not match its recorded hash");
    }
    const tx = decodeTx(clean);
    if (!tx.signed) throw new Error("stored transaction is not signed");
    if (tx.chainId !== BigInt(p.chain_id)) throw new Error("stored transaction is for another chain");
    if (tx.nonce !== BigInt(p.nonce)) throw new Error("stored transaction uses another nonce");
    if (tx.to !== normalizeAddress(hex(p.token))) throw new Error("stored transaction addresses another contract");
    if (tx.value !== 0n) throw new Error("stored transaction carries value");
    if (tx.data !== encodeTransfer(hex(p.destination), BigInt(p.amount))) {
      throw new Error("stored transaction is not the bound transfer");
    }
  }
}
