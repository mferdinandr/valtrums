import { describe, expect, it } from "vitest";
import { TRANSFER_TOPIC, encodeTransfer, fromHex, toHex } from "../src/evm-abi.js";
import type { EvmReceipt } from "../src/evm-rpc.js";
import { FakeEvmRpc } from "../src/fake-evm-rpc.js";
import { encodeTx, txHash } from "../src/evm-tx.js";
import { NearPayoutLedger } from "../src/near-payout-client.js";
import type { NearTransport } from "../src/near-client.js";
import {
  type Hash,
  type PaymentEvidenceInput,
  type PayoutChainReader,
  type PayoutOutcome,
  type PayoutLedger,
  PayoutReconciler,
} from "../src/payout-reconciler.js";
import type { PayoutAttemptView, PayoutHoldReason, PayoutView } from "../src/payout-status.js";
import { loadPayoutReconcileConfig } from "../src/payout-wiring.js";

// Everything here is a fixture: an in-memory chain and ledger, not a live node or payout contract.

const CHAIN = 46630n;
const TOKEN = "0x2626664c2603336e57b271c5c0b26f421741e481";
const SENDER = "0x1111111111111111111111111111111111111111";
const DEST = "0x000000000000000000000000000000000000dead";
const AMOUNT = 1_000_000n;
const NONCE = 7n;
const bytes = (h: string): number[] => [...fromHex(h)];

function signedTx(fee: bigint, over: { to?: string; amount?: bigint; nonce?: bigint } = {}): { raw: string; hash: string } {
  const raw = encodeTx(
    {
      chainId: CHAIN,
      nonce: over.nonce ?? NONCE,
      maxPriorityFeePerGas: fee,
      maxFeePerGas: fee,
      gasLimit: 120_000n,
      to: TOKEN,
      value: 0n,
      data: encodeTransfer(over.to ?? DEST, over.amount ?? AMOUNT),
    },
    { yParity: 1, r: new Uint8Array(32).fill(1), s: new Uint8Array(32).fill(2) },
  );
  return { raw, hash: txHash(raw) };
}

type AttemptState = PayoutAttemptView["state"];

function attemptOf(fee: bigint, state: AttemptState, over = {}): PayoutAttemptView & { raw: string } {
  const tx = signedTx(fee, over);
  return { tx_hash: bytes(tx.hash), max_fee_per_gas: fee.toString(), state, raw: tx.raw };
}

function payout(state: PayoutView["state"], attempts: Array<PayoutAttemptView & { raw?: string }>, id = 1): PayoutView {
  return {
    backing: "backing.testnet",
    holder: "alice.testnet",
    request_id: Array(32).fill(id),
    state,
    reason: null,
    terminal: false,
    chain_id: CHAIN.toString(),
    token: bytes(TOKEN),
    sender: bytes(SENDER),
    destination: bytes(DEST),
    amount: AMOUNT.toString(),
    path: "custody-1",
    nonce: NONCE.toString(),
    binding_hash: Array(32).fill(9),
    attempts: attempts.map(({ tx_hash, max_fee_per_gas, state: s }) => ({ tx_hash, max_fee_per_gas, state: s })),
    evidence_hash: null,
  };
}

class FakeLedger implements PayoutLedger {
  readonly calls: string[] = [];
  /** Calls that actually changed stored state; a repeat the contract would accept as a no-op is not listed. */
  readonly effects: string[] = [];
  readonly args: Array<{ method: string; arg: unknown }> = [];
  readonly raws = new Map<string, string>();
  constructor(readonly payouts: PayoutView[]) {}
  private note(method: string, arg: unknown): void {
    this.calls.push(method);
    this.args.push({ method, arg });
  }
  private stored(p: PayoutView): PayoutView {
    const s = this.payouts.find((x) => x.backing === p.backing && x.holder === p.holder && toHex(Uint8Array.from(x.request_id)) === toHex(Uint8Array.from(p.request_id)));
    if (!s) throw new Error("unknown payout");
    return s;
  }
  private find(p: PayoutView, h: Hash): PayoutAttemptView {
    const a = p.attempts.find((x) => toHex(Uint8Array.from(x.tx_hash)) === toHex(Uint8Array.from(h)));
    if (!a) throw new Error("unknown attempt");
    return a;
  }
  /** Fresh copies, like a real view call: a stale snapshot never aliases stored state. */
  async listOpenPayouts(): Promise<PayoutView[]> {
    await Promise.resolve();
    return structuredClone(this.payouts.filter((p) => p.state !== "confirmed" && p.state !== "restored"));
  }
  async getSignedTransaction(_p: PayoutView, h: Hash): Promise<string | null> {
    return this.raws.get(toHex(Uint8Array.from(h))) ?? null;
  }
  async recordBroadcast(p: PayoutView, h: Hash): Promise<void> {
    this.note("record_broadcast", h);
    await Promise.resolve();
    const s = this.stored(p);
    const a = this.find(s, h);
    if (a.state === "broadcast" || a.state === "pending") return;
    a.state = "broadcast";
    s.state = "broadcast";
    this.effects.push("record_broadcast");
  }
  async recordPendingFinality(p: PayoutView, h: Hash): Promise<void> {
    this.note("record_pending_finality", h);
    await Promise.resolve();
    const s = this.stored(p);
    const a = this.find(s, h);
    if (a.state === "pending") return;
    if (a.state !== "broadcast") throw new Error("WrongState");
    a.state = "pending";
    s.state = "pending_finality";
    this.effects.push("record_pending_finality");
  }
  async requireReconciliation(p: PayoutView, reason: PayoutHoldReason): Promise<void> {
    this.note("require_reconciliation", reason);
    await Promise.resolve();
    const s = this.stored(p);
    if (s.state === "reconciliation_required" && s.reason === reason) return;
    s.state = "reconciliation_required";
    s.reason = reason;
    this.effects.push("require_reconciliation");
  }
}

class FakeChain implements PayoutChainReader {
  finalized = { number: 100n, hash: `0x${"ab".repeat(32)}` };
  chain = CHAIN;
  pendingNonce = NONCE;
  finalizedNonce = NONCE;
  readonly mempool = new Set<string>();
  readonly receipts = new Map<string, EvmReceipt>();
  readonly sent: string[] = [];
  failSend = false;
  failReceiptFor: string | null = null;
  async chainId(): Promise<bigint> {
    return this.chain;
  }
  async getFinalizedBlock(): Promise<{ number: bigint; hash: string }> {
    return this.finalized;
  }
  async getBlockHash(n: bigint): Promise<string | null> {
    return [...this.receipts.values()].find((r) => r.blockNumber === n)?.blockHash ?? null;
  }
  async getTransactionCount(_a: string, tag: "pending" | "latest" | "finalized"): Promise<bigint> {
    return tag === "finalized" ? this.finalizedNonce : this.pendingNonce;
  }
  async getTransactionReceipt(hash: string): Promise<EvmReceipt | null> {
    if (this.failReceiptFor === hash) throw new Error("EVM RPC eth_getTransactionReceipt request failed: error");
    return this.receipts.get(hash) ?? null;
  }
  async isTransactionKnown(hash: string): Promise<boolean> {
    return this.mempool.has(hash) || this.receipts.has(hash);
  }
  async sendRawTransaction(raw: string): Promise<string> {
    this.sent.push(raw.replace(/^0x/, ""));
    if (this.failSend) throw new Error("EVM RPC eth_sendRawTransaction request failed: error");
    const hash = txHash(raw.replace(/^0x/, ""));
    this.mempool.add(hash);
    return hash;
  }
  receipt(hash: string, over: Partial<EvmReceipt> & { transferAmount?: bigint } = {}): void {
    const word = (h: string): string => `0x${h.replace(/^0x/, "").padStart(64, "0")}`;
    this.receipts.set(hash, {
      transactionHash: hash,
      status: over.status ?? true,
      blockNumber: over.blockNumber ?? 90n,
      blockHash: over.blockHash ?? `0x${"cd".repeat(32)}`,
      logs:
        over.logs ??
        (over.status === false
          ? []
          : [
              {
                address: TOKEN,
                topics: [TRANSFER_TOPIC, word(SENDER), word(DEST)],
                data: word((over.transferAmount ?? AMOUNT).toString(16)),
                logIndex: 3,
              },
            ]),
    });
  }
}

function setup(payouts: PayoutView[], opts: { now?: () => number } = {}) {
  const ledger = new FakeLedger(payouts);
  const chain = new FakeChain();
  const reconciler = new PayoutReconciler(ledger, chain, { ...(opts.now ? { now: opts.now } : {}), signingGraceMs: 60_000 });
  return { ledger, chain, reconciler };
}

const id = (p: PayoutView): Hash => p.request_id;

describe("PayoutReconciler gate", () => {
  it("allows nothing before the first complete pass and clears an authorized payout after it", async () => {
    const p = payout("authorized", []);
    const { reconciler } = setup([p]);
    expect(reconciler.spendAllowed(p.backing, p.holder, id(p))).toBe(false);
    const report = await reconciler.reconcile();
    expect(report.outcomes[0]).toMatchObject({ kind: "idle", spendAllowed: true });
    expect(reconciler.spendAllowed(p.backing, p.holder, id(p))).toBe(true);
    expect(reconciler.spendAllowed(p.backing, p.holder, Array(32).fill(77))).toBe(false);
  });

  it("keeps the gate closed for a payout with a signature the chain has not settled", async () => {
    const a = attemptOf(100n, "signed");
    const p = payout("signed", [a]);
    const { reconciler, ledger } = setup([p]);
    ledger.raws.set(txHash(a.raw), a.raw);
    await reconciler.reconcile();
    expect(reconciler.spendAllowed(p.backing, p.holder, id(p))).toBe(false);
  });
});

describe("restart: signed but possibly never sent", () => {
  it("sends the identical stored transaction again when the node does not know it and the slot is free", async () => {
    const a = attemptOf(100n, "signed");
    const p = payout("signed", [a]);
    const { reconciler, ledger, chain } = setup([p]);
    ledger.raws.set(txHash(a.raw), a.raw);
    const report = await reconciler.reconcile();
    expect(report.outcomes[0]).toMatchObject({ kind: "rebroadcast", spendAllowed: false });
    expect(chain.sent).toEqual([a.raw]);
    expect(ledger.calls).toEqual(["record_broadcast"]);
  });

  it("rebroadcasts the highest-fee attempt only, the replacement", async () => {
    const low = attemptOf(100n, "broadcast");
    const high = attemptOf(200n, "signed");
    const p = payout("broadcast", [low, high]);
    const { reconciler, ledger, chain } = setup([p]);
    ledger.raws.set(txHash(low.raw), low.raw);
    ledger.raws.set(txHash(high.raw), high.raw);
    await reconciler.reconcile();
    expect(chain.sent).toEqual([high.raw]);
  });

  it("treats a send error as success when the node knows the transaction afterwards", async () => {
    const a = attemptOf(100n, "signed");
    const p = payout("signed", [a]);
    const { reconciler, ledger, chain } = setup([p]);
    ledger.raws.set(txHash(a.raw), a.raw);
    const send = chain.sendRawTransaction.bind(chain);
    chain.sendRawTransaction = async (raw) => {
      await send(raw);
      throw new Error("timeout after accept");
    };
    const report = await reconciler.reconcile();
    expect(report.outcomes[0]?.kind).toBe("rebroadcast");
  });

  it("reports an error and stays closed when the send fails and the node does not know the transaction", async () => {
    const a = attemptOf(100n, "signed");
    const p = payout("signed", [a]);
    const { reconciler, ledger, chain } = setup([p]);
    ledger.raws.set(txHash(a.raw), a.raw);
    chain.failSend = true;
    const report = await reconciler.reconcile();
    expect(report.outcomes[0]).toMatchObject({ kind: "error", spendAllowed: false });
    expect(ledger.calls).toEqual([]);
  });

  it("refuses to send stored bytes that are not the bound transfer", async () => {
    const a = attemptOf(100n, "signed");
    const p = payout("signed", [a]);
    const { reconciler, ledger, chain } = setup([p]);
    const tampered = signedTx(100n, { to: "0x000000000000000000000000000000000000beef" });
    // Same recorded hash, different bytes: the hash check fails first.
    ledger.raws.set(txHash(a.raw), tampered.raw);
    let report = await reconciler.reconcile();
    expect(report.outcomes[0]).toMatchObject({ kind: "error", spendAllowed: false });
    // A self-consistent but wrong transaction (hash recorded for it) fails the content check.
    const b = attemptOf(300n, "signed", { to: "0x000000000000000000000000000000000000beef" });
    const q = payout("signed", [b], 2);
    ledger.payouts.splice(0, 1, q);
    ledger.raws.set(txHash(b.raw), b.raw);
    report = await reconciler.reconcile();
    expect(report.outcomes[0]).toMatchObject({ kind: "error" });
    expect(report.outcomes[0]?.detail).toContain("not the bound transfer");
    expect(chain.sent).toEqual([]);
  });
});

describe("restart: transaction on the network", () => {
  it("records the sighting for a mempool transaction and is idempotent on the next pass", async () => {
    const a = attemptOf(100n, "broadcast");
    const p = payout("broadcast", [a]);
    const { reconciler, ledger, chain } = setup([p]);
    chain.mempool.add(txHash(a.raw));
    let r = await reconciler.reconcile();
    expect(r.outcomes[0]).toMatchObject({ kind: "waiting", spendAllowed: false });
    expect(ledger.calls).toEqual(["record_pending_finality"]);
    r = await reconciler.reconcile();
    expect(ledger.calls).toEqual(["record_pending_finality"]);
    expect(chain.sent).toEqual([]);
  });

  it("moves a signed but already mined attempt through broadcast to pending before it is final", async () => {
    const a = attemptOf(100n, "signed");
    const p = payout("signed", [a]);
    const { reconciler, ledger, chain } = setup([p]);
    chain.receipt(txHash(a.raw), { blockNumber: 101n });
    const r = await reconciler.reconcile();
    expect(r.outcomes[0]).toMatchObject({ kind: "waiting" });
    expect(ledger.calls).toEqual(["record_broadcast", "record_pending_finality"]);
    expect(ledger.args.some((x) => x.method === "confirm_payout")).toBe(false);
  });
});

const OPERATOR_METHODS = ["confirm_payout", "record_revert", "restore_payout"];

/** The reconciler never calls an operator method; it reports the proof for one. */
const noOperatorCall = (ledger: FakeLedger): void => {
  for (const m of OPERATOR_METHODS) expect(ledger.calls).not.toContain(m);
};

describe("confirmation is reported, never sent", () => {
  it("reports confirm_payout with evidence built from a finalized exact transfer", async () => {
    const a = attemptOf(100n, "pending");
    const p = payout("pending_finality", [a]);
    const { reconciler, ledger, chain } = setup([p]);
    chain.receipt(txHash(a.raw));
    const r = await reconciler.reconcile();
    expect(r.outcomes[0]).toMatchObject({ kind: "needs_operator", spendAllowed: false });
    noOperatorCall(ledger);
    expect(ledger.calls).toEqual([]);
    const call = r.outcomes[0]?.proof?.calls[0];
    expect(call?.method).toBe("confirm_payout");
    const evidence = (call as { evidence: PaymentEvidenceInput }).evidence;
    expect(r.outcomes[0]?.proof?.facts).toMatchObject({
      tx_hash: txHash(a.raw),
      block_hash: `0x${"cd".repeat(32)}`,
      evidence_hash: toHex(Uint8Array.from(evidence.evidence_hash)),
    });
    expect(evidence).toMatchObject({
      chain_id: CHAIN.toString(),
      amount: AMOUNT.toString(),
      log_index: 3,
      block_number: "90",
      finalized_head_number: "100",
      tx_hash: a.tx_hash,
      recipient: p.destination,
    });
    expect(evidence.evidence_hash).toHaveLength(32);
    expect(evidence.evidence_hash.some((b) => b !== 0)).toBe(true);
    expect(chain.sent).toEqual([]);
  });

  it("reports the replacement that was mined, not the replaced attempt", async () => {
    const low = attemptOf(100n, "broadcast");
    const high = attemptOf(200n, "pending");
    const p = payout("pending_finality", [low, high]);
    const { reconciler, ledger, chain } = setup([p]);
    chain.receipt(txHash(high.raw));
    const r = await reconciler.reconcile();
    const call = r.outcomes[0]?.proof?.calls[0] as { evidence: PaymentEvidenceInput };
    expect(call.evidence.tx_hash).toEqual(high.tx_hash);
    noOperatorCall(ledger);
    expect(chain.sent).toEqual([]);
  });

  it("does not confirm a transfer of a different amount and holds the payout instead", async () => {
    const a = attemptOf(100n, "pending");
    const p = payout("pending_finality", [a]);
    const { reconciler, ledger, chain } = setup([p]);
    chain.receipt(txHash(a.raw), { transferAmount: AMOUNT - 1n });
    const r = await reconciler.reconcile();
    expect(r.outcomes[0]).toMatchObject({ kind: "held", spendAllowed: false });
    expect(ledger.calls).toEqual(["require_reconciliation"]);
    expect(ledger.args[0]?.arg).toBe("EvidenceUnavailable");
    expect(chain.sent).toEqual([]);
  });

  it("does not confirm when the receipt block is not the canonical block", async () => {
    const a = attemptOf(100n, "pending");
    const p = payout("pending_finality", [a]);
    const { reconciler, ledger, chain } = setup([p]);
    chain.receipt(txHash(a.raw));
    chain.getBlockHash = async () => `0x${"ee".repeat(32)}`;
    const r = await reconciler.reconcile();
    expect(r.outcomes[0]?.kind).toBe("held");
    expect(ledger.calls).toEqual(["require_reconciliation"]);
  });

});

describe("revert and release are reported, never sent", () => {
  it("reports record_revert and restore_payout only after the nonce slot is finalized", async () => {
    const a = attemptOf(100n, "pending");
    const p = payout("pending_finality", [a]);
    const { reconciler, ledger, chain } = setup([p]);
    chain.receipt(txHash(a.raw), { status: false });
    chain.finalizedNonce = NONCE; // slot not finalized yet
    let r = await reconciler.reconcile();
    expect(r.outcomes[0]).toMatchObject({ kind: "waiting" });
    expect(r.outcomes[0]?.proof).toBeUndefined();
    chain.finalizedNonce = NONCE + 1n;
    r = await reconciler.reconcile();
    expect(r.outcomes[0]).toMatchObject({ kind: "needs_operator", spendAllowed: false });
    const calls = r.outcomes[0]?.proof?.calls ?? [];
    expect(calls.map((c) => c.method)).toEqual(["record_revert", "restore_payout"]);
    const restore = calls[1] as { proof: { outcome: unknown; finalized_nonce: string } };
    expect(restore.proof.outcome).toEqual({ OurTxReverted: a.tx_hash });
    expect(restore.proof.finalized_nonce).toBe((NONCE + 1n).toString());
    expect(r.outcomes[0]?.proof?.facts).toMatchObject({ reverted_hash: txHash(a.raw), finalized_nonce: "8", payout_nonce: "7" });
    noOperatorCall(ledger);
    expect(ledger.calls).toEqual([]);
    expect(chain.sent).toEqual([]);
  });

  it("does not restore while one attempt is still open", async () => {
    const reverted = attemptOf(100n, "broadcast");
    const open = attemptOf(200n, "broadcast");
    const p = payout("broadcast", [reverted, open]);
    const { reconciler, ledger, chain } = setup([p]);
    chain.receipt(txHash(reverted.raw), { status: false });
    chain.mempool.add(txHash(open.raw));
    chain.finalizedNonce = NONCE + 1n;
    const r = await reconciler.reconcile();
    expect(r.outcomes[0]).toMatchObject({ kind: "waiting" });
    expect(ledger.calls).not.toContain("restore_payout");
  });
});

describe("unresolved slots and the signer", () => {
  it("holds instead of rebroadcasting when the nonce is used but none of our attempts is on chain", async () => {
    const a = attemptOf(100n, "broadcast");
    const p = payout("broadcast", [a]);
    const { reconciler, ledger, chain } = setup([p]);
    chain.pendingNonce = NONCE + 1n;
    const r = await reconciler.reconcile();
    expect(r.outcomes[0]).toMatchObject({ kind: "held", spendAllowed: false });
    expect(ledger.calls).toEqual(["require_reconciliation"]);
    expect(chain.sent).toEqual([]);
  });

  it("waits for the signer, then holds after the grace period without creating a spend", async () => {
    let now = 0;
    const p = payout("signing_requested", [{ tx_hash: Array(32).fill(0), max_fee_per_gas: "100", state: "requested" }]);
    const { reconciler, ledger, chain } = setup([p], { now: () => now });
    let r = await reconciler.reconcile();
    expect(r.outcomes[0]).toMatchObject({ kind: "waiting", spendAllowed: false });
    now = 61_000;
    r = await reconciler.reconcile();
    expect(r.outcomes[0]).toMatchObject({ kind: "held" });
    expect(ledger.calls).toEqual(["require_reconciliation"]);
    expect(ledger.args[0]?.arg).toBe("SignerNoResponse");
    expect(chain.sent).toEqual([]);
    expect(reconciler.spendAllowed(p.backing, p.holder, id(p))).toBe(false);
  });

  it("keeps a held payout without any recorded attempt closed", async () => {
    const p = payout("reconciliation_required", []);
    const { reconciler, ledger } = setup([p]);
    const r = await reconciler.reconcile();
    expect(r.outcomes[0]).toMatchObject({ kind: "held", spendAllowed: false });
    expect(ledger.calls).toEqual([]);
  });
});

describe("failure isolation", () => {
  it("fails closed on a chain id mismatch", async () => {
    const p = payout("authorized", []);
    const { reconciler, chain } = setup([p]);
    chain.chain = 1n;
    const r = await reconciler.reconcile();
    expect(r.outcomes[0]).toMatchObject({ kind: "error", spendAllowed: false });
    expect(r.errors).toBe(1);
  });

  it("fails closed when the finalized head is unavailable", async () => {
    const p = payout("authorized", []);
    const { reconciler, chain } = setup([p]);
    chain.getFinalizedBlock = async () => {
      throw new Error("no finalized block");
    };
    const r = await reconciler.reconcile();
    expect(r.outcomes[0]).toMatchObject({ kind: "error", spendAllowed: false });
  });

  it("one failing payout does not stop the others", async () => {
    const a = attemptOf(100n, "pending");
    const bad = payout("pending_finality", [a], 1);
    const b = attemptOf(150n, "pending");
    const good = payout("pending_finality", [b], 2);
    const { reconciler, chain } = setup([bad, good]);
    chain.failReceiptFor = txHash(a.raw);
    chain.receipt(txHash(b.raw));
    const r = await reconciler.reconcile();
    expect(r.outcomes.map((o) => o.kind)).toEqual(["error", "needs_operator"]);
  });
});

describe("NearPayoutLedger", () => {
  function transport() {
    const calls: Array<{ kind: string; method: string; args: Record<string, unknown>; gas?: string; deposit?: string }> = [];
    const pages: Record<string, { items: PayoutView[]; next_index: string }> = {
      "0": { items: [payout("signed", [], 1)], next_index: "50" },
      "50": { items: [payout("signed", [], 2)], next_index: "75" },
    };
    const t: NearTransport = {
      async view<T>(_c: string, method: string, args: object) {
        calls.push({ kind: "view", method, args: args as Record<string, unknown> });
        if (method === "get_payout_count") return "75" as T;
        if (method === "list_open_payouts") return pages[(args as { from_index: string }).from_index] as T;
        return null as T;
      },
      async call(_c, method, args, gas, deposit) {
        calls.push({ kind: "call", method, args: args as Record<string, unknown>, gas, ...(deposit ? { deposit } : {}) });
        return {};
      },
    };
    return { t, calls };
  }

  it("walks every page of open payouts", async () => {
    const { t } = transport();
    const items = await new NearPayoutLedger("payout.testnet", t).listOpenPayouts();
    expect(items).toHaveLength(2);
  });

  it("attaches one yocto and sends hashes as byte arrays", async () => {
    const { t, calls } = transport();
    const ledger = new NearPayoutLedger("payout.testnet", t);
    const p = payout("signed", [], 1);
    await ledger.recordBroadcast(p, Array(32).fill(5));
    await ledger.requireReconciliation(p, "EvidenceUnavailable");
    expect(calls[0]).toMatchObject({
      kind: "call",
      method: "record_broadcast",
      deposit: "1 yocto",
      args: { backing: "backing.testnet", holder: "alice.testnet", tx_hash: Array(32).fill(5) },
    });
    expect(calls[1]?.args.reason).toBe("EvidenceUnavailable");
  });

  it("has no operator method at all and only ever calls relayer methods", async () => {
    const { t, calls } = transport();
    const ledger = new NearPayoutLedger("payout.testnet", t) as unknown as Record<string, unknown>;
    for (const name of ["confirmPayout", "restorePayout", "recordRevert"]) expect(ledger[name]).toBeUndefined();
    const p = payout("signed", [], 1);
    const l = ledger as unknown as NearPayoutLedger;
    await l.recordBroadcast(p, Array(32).fill(5));
    await l.recordPendingFinality(p, Array(32).fill(5));
    await l.requireReconciliation(p, "SignerNoResponse");
    expect(calls.map((c) => c.method)).toEqual(["record_broadcast", "record_pending_finality", "require_reconciliation"]);
  });

  it("does not loop on a page that does not advance", async () => {
    const t: NearTransport = {
      async view<T>(_c: string, method: string) {
        return (method === "get_payout_count" ? "10" : { items: [], next_index: "0" }) as T;
      },
      async call() {
        return {};
      },
    };
    await expect(new NearPayoutLedger("payout.testnet", t).listOpenPayouts()).rejects.toThrow(/advance/);
  });
});

describe("loadPayoutReconcileConfig", () => {
  it("is off by default", () => {
    expect(loadPayoutReconcileConfig({})).toBeNull();
  });

  it("requires the contract and an https EVM RPC", () => {
    const on = { PAYOUT_RECONCILE_ENABLED: "true" };
    expect(() => loadPayoutReconcileConfig(on)).toThrow(/PAYOUT_CONTRACT_ID/);
    expect(() => loadPayoutReconcileConfig({ ...on, PAYOUT_CONTRACT_ID: "p.testnet", PAYOUT_EVM_RPC_URL: "http://x" })).toThrow(/https/);
    const base = { ...on, PAYOUT_CONTRACT_ID: "p.testnet", PAYOUT_EVM_RPC_URL: "https://rpc.example" };
    expect(loadPayoutReconcileConfig(base)).toMatchObject({ contractId: "p.testnet", signingGraceMs: 300_000 });
  });

  it("fails closed when an operator variable is set, enabled or not", () => {
    const base = { PAYOUT_RECONCILE_ENABLED: "true", PAYOUT_CONTRACT_ID: "p.testnet", PAYOUT_EVM_RPC_URL: "https://rpc.example" };
    for (const name of ["PAYOUT_OPERATOR_ACCOUNT_ID", "PAYOUT_OPERATOR_PRIVATE_KEY"]) {
      expect(() => loadPayoutReconcileConfig({ ...base, [name]: "x" })).toThrow(/never holds the operator key/);
      expect(() => loadPayoutReconcileConfig({ [name]: "x" })).toThrow(/never holds the operator key/);
    }
    expect(loadPayoutReconcileConfig({ ...base, PAYOUT_OPERATOR_ACCOUNT_ID: "" })).not.toBeNull();
  });
});

// ─── the existing FakeEvmRpc as the chain: acceptance scenarios, concurrency, idempotence ───

const blockHashOf = (n: bigint): string => `0x${n.toString(16).padStart(64, "0")}`;

/** Adds what the reconciler needs (finalized head, block hashes, log indexes) on top of FakeEvmRpc. */
class FakeRpcChain implements PayoutChainReader {
  constructor(readonly rpc: FakeEvmRpc) {}
  chainId = () => this.rpc.chainId();
  async getFinalizedBlock() {
    return { number: this.rpc.head, hash: blockHashOf(this.rpc.head) };
  }
  async getBlockHash(n: bigint): Promise<string | null> {
    await Promise.resolve();
    return n <= this.rpc.head ? blockHashOf(n) : null;
  }
  async getTransactionCount(a: string): Promise<bigint> {
    await Promise.resolve();
    return this.rpc.getTransactionCount(a);
  }
  async getTransactionReceipt(h: string): Promise<EvmReceipt | null> {
    await Promise.resolve();
    const r = await this.rpc.getTransactionReceipt(h);
    return r ? { ...r, blockHash: blockHashOf(r.blockNumber), logs: r.logs.map((l, i) => ({ ...l, logIndex: i })) } : null;
  }
  async isTransactionKnown(h: string): Promise<boolean> {
    await Promise.resolve();
    return this.rpc.isTransactionKnown(h);
  }
  async sendRawTransaction(raw: string): Promise<string> {
    await Promise.resolve();
    return this.rpc.sendRawTransaction(raw);
  }
}

/** A signed transfer whose sender the fake chain reads from `r`. */
function fakeSigned(fee: bigint): { raw: string; hash: string } {
  const r = new Uint8Array(32);
  r.set(fromHex(SENDER), 12);
  const raw = encodeTx(
    {
      chainId: CHAIN,
      nonce: NONCE,
      maxPriorityFeePerGas: fee,
      maxFeePerGas: fee,
      gasLimit: 120_000n,
      to: TOKEN,
      value: 0n,
      data: encodeTransfer(DEST, AMOUNT),
    },
    { yParity: 1, r, s: new Uint8Array(32).fill(2) },
  );
  return { raw, hash: txHash(raw) };
}

function world(states: Array<[bigint, AttemptState]>, manualMining = false) {
  const rpc = new FakeEvmRpc();
  rpc.chain = CHAIN;
  rpc.manualMining = manualMining;
  rpc.nonces.set(SENDER, NONCE);
  rpc.setToken(TOKEN, SENDER, 10n * AMOUNT);
  const txs = states.map(([fee, st]) => ({ fee, ...fakeSigned(fee), st }));
  const overall: PayoutView["state"] = txs.some((t) => t.st === "pending") ? "pending_finality" : txs.some((t) => t.st === "broadcast") ? "broadcast" : "signed";
  const p = payout(
    overall,
    txs.map((t) => ({ tx_hash: bytes(t.hash), max_fee_per_gas: t.fee.toString(), state: t.st })),
  );
  const ledger = new FakeLedger([p]);
  for (const t of txs) ledger.raws.set(t.hash, t.raw);
  const chain = new FakeRpcChain(rpc);
  const make = () => new PayoutReconciler(ledger, chain);
  const delivered = () => rpc.tokenBalance(TOKEN, DEST);
  const distinctSent = () => new Set(rpc.broadcasts).size;
  return { rpc, ledger, p, txs, make, delivered, distinctSent };
}

const only = <T,>(w: { txs: T[] }): T => w.txs[0] as T;
const proofMethods = (o: { proof?: { calls: Array<{ method: string }> } } | undefined): string[] =>
  o?.proof?.calls.map((c) => c.method) ?? [];

describe("acceptance scenarios on FakeEvmRpc: no second spend, operator writes only reported", () => {
  it("restart with a pending transaction: records the sighting, then reports the confirmation proof", async () => {
    const w = world([[100n, "broadcast"]], true);
    await w.rpc.sendRawTransaction(only(w).raw); // sent before the crash, not yet mined
    const sentBefore = w.rpc.broadcasts.length;
    await w.make().reconcile();
    expect(w.ledger.effects).toEqual(["record_pending_finality"]);
    expect(w.rpc.broadcasts.length).toBe(sentBefore);
    w.rpc.mine();
    const r = await w.make().reconcile();
    expect(r.outcomes[0]).toMatchObject({ kind: "needs_operator" });
    expect(proofMethods(r.outcomes[0])).toEqual(["confirm_payout"]);
    expect(w.ledger.effects).toEqual(["record_pending_finality"]);
    noOperatorCall(w.ledger);
    expect(w.delivered()).toBe(AMOUNT);
    expect(w.rpc.broadcasts.length).toBe(sentBefore);
  });

  it("replacement: sends only the highest-fee attempt and reports that one", async () => {
    const w = world([
      [100n, "broadcast"],
      [200n, "signed"],
    ]);
    await w.make().reconcile();
    expect(w.distinctSent()).toBe(1);
    const r = await w.make().reconcile();
    const call = r.outcomes[0]?.proof?.calls[0] as { evidence: PaymentEvidenceInput };
    expect(call.evidence.tx_hash).toEqual(bytes((w.txs[1] as (typeof w.txs)[number]).hash));
    noOperatorCall(w.ledger);
    expect(w.delivered()).toBe(AMOUNT);
    expect(w.distinctSent()).toBe(1);
  });

  it("lost response: the signed but unsent transaction goes out once, then the confirmation is reported", async () => {
    const w = world([[100n, "signed"]]);
    await w.make().reconcile();
    const r = await w.make().reconcile();
    expect(w.ledger.effects).toEqual(["record_broadcast"]);
    expect(proofMethods(r.outcomes[0])).toEqual(["confirm_payout"]);
    noOperatorCall(w.ledger);
    expect(w.distinctSent()).toBe(1);
    expect(w.delivered()).toBe(AMOUNT);
  });

  it("reverted attempt: the revert and release are reported with a proof and nothing is sent again", async () => {
    const w = world([[100n, "signed"]]);
    w.rpc.shouldRevert = () => true;
    await w.make().reconcile();
    const r = await w.make().reconcile();
    expect(w.ledger.effects).toEqual(["record_broadcast"]);
    expect(proofMethods(r.outcomes[0])).toEqual(["record_revert", "restore_payout"]);
    noOperatorCall(w.ledger);
    expect(w.distinctSent()).toBe(1);
    expect(w.delivered()).toBe(0n);
  });
});

describe("concurrent and repeated runs on FakeEvmRpc", () => {
  const settle = async (w: ReturnType<typeof world>) => {
    let last: PayoutOutcome | undefined;
    for (let i = 0; i < 3; i++) {
      const [a, b] = await Promise.all([w.make().reconcile(), w.make().reconcile()]);
      for (const o of [...a.outcomes, ...b.outcomes]) expect(o.kind).not.toBe("error");
      last = b.outcomes[0];
    }
    return last;
  };

  it("two concurrent instances on a lost response conflict nowhere and pay once", async () => {
    const w = world([[100n, "signed"]]);
    const last = await settle(w);
    expect(w.ledger.effects).toEqual(["record_broadcast"]);
    expect(proofMethods(last)).toEqual(["confirm_payout"]);
    noOperatorCall(w.ledger);
    expect(w.distinctSent()).toBe(1);
    expect(w.delivered()).toBe(AMOUNT);
  });

  it("two concurrent instances on a replacement send one distinct transaction", async () => {
    const w = world([
      [100n, "broadcast"],
      [200n, "signed"],
    ]);
    const last = await settle(w);
    expect(w.distinctSent()).toBe(1);
    expect(proofMethods(last)).toEqual(["confirm_payout"]);
    noOperatorCall(w.ledger);
    expect(w.delivered()).toBe(AMOUNT);
  });

  it("two concurrent instances on a revert report the same proof and never resend", async () => {
    const w = world([[100n, "signed"]]);
    w.rpc.shouldRevert = () => true;
    const last = await settle(w);
    expect(w.ledger.effects).toEqual(["record_broadcast"]);
    expect(proofMethods(last)).toEqual(["record_revert", "restore_payout"]);
    noOperatorCall(w.ledger);
    expect(w.distinctSent()).toBe(1);
    expect(w.delivered()).toBe(0n);
  });

  it("two concurrent instances on a pending transaction record the sighting once", async () => {
    const w = world([[100n, "broadcast"]], true);
    await w.rpc.sendRawTransaction(only(w).raw);
    await Promise.all([w.make().reconcile(), w.make().reconcile()]);
    expect(w.ledger.effects).toEqual(["record_pending_finality"]);
  });

  it("a repeated run changes nothing: no ledger write, no broadcast, same state, same report", async () => {
    const w = world([[100n, "broadcast"]], true);
    await w.rpc.sendRawTransaction(only(w).raw);
    await w.make().reconcile();
    w.rpc.mine();
    const first = await w.make().reconcile();
    const snapshot = JSON.stringify(w.p);
    const calls = w.ledger.calls.length;
    const sent = w.rpc.broadcasts.length;
    for (let i = 0; i < 3; i++) {
      const again = await w.make().reconcile();
      expect(again.outcomes).toEqual(first.outcomes);
    }
    expect(w.ledger.calls.length).toBe(calls);
    expect(w.rpc.broadcasts.length).toBe(sent);
    expect(JSON.stringify(w.p)).toBe(snapshot);
  });

  it("a held payout is not held again by a later run", async () => {
    const w = world([[100n, "broadcast"]]);
    w.rpc.nonces.set(SENDER, NONCE + 1n); // slot used by something else, no attempt of ours on chain
    await w.make().reconcile();
    const calls = w.ledger.calls.length;
    await w.make().reconcile();
    expect(w.ledger.effects).toEqual(["require_reconciliation"]);
    expect(w.ledger.calls.length).toBe(calls);
    expect(w.distinctSent()).toBe(0);
  });
});

describe("operator reporting", () => {
  it("reports findings through the agent log at a level that matches their urgency", async () => {
    const lines: Array<{ level: string; kind: unknown; proof?: boolean }> = [];
    const add = (level: string, f?: Record<string, unknown>) =>
      lines.push({ level, kind: f?.kind, ...(f?.proof ? { proof: true } : {}) });
    const log = {
      info: (_m: string, f?: Record<string, unknown>) => add("info", f),
      warn: (_m: string, f?: Record<string, unknown>) => add("warn", f),
      error: (_m: string, f?: Record<string, unknown>) => add("error", f),
    };
    const held = payout("reconciliation_required", [], 1);
    const idle = payout("authorized", [], 2);
    const needs = payout("pending_finality", [attemptOf(100n, "pending")], 3);
    const ledger = new FakeLedger([held, idle, needs]);
    const chain = new FakeChain();
    chain.receipt(txHash(attemptOf(100n, "pending").raw));
    await new PayoutReconciler(ledger, chain, { log }).reconcile();
    expect(lines).toEqual([
      { level: "warn", kind: "held" },
      { level: "info", kind: "idle" },
      { level: "warn", kind: "needs_operator", proof: true },
    ]);
  });
});
