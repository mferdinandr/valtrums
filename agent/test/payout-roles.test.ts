// FIXTURE-ONLY: in-memory payout ledger and source chain. No NEAR RPC, signer, EVM node or funds.
import { describe, expect, it } from "vitest";
import { TRANSFER_TOPIC, encodeTransfer, fromHex } from "../src/evm-abi.js";
import type { EvmReceipt } from "../src/evm-rpc.js";
import { encodeTx, txHash } from "../src/evm-tx.js";
import { NearPayoutLedger, NearPayoutOperatorLedger, requestPayoutSignature } from "../src/near-payout-client.js";
import type { NearTransport } from "../src/near-client.js";
import { PayoutOperator, checkOperatorProof, type OperatorSubmitter } from "../src/payout-operator.js";
import { PayoutReconciler, evidenceHash, type Hash, type OperatorProof, type PayoutChainReader, type PayoutLedger } from "../src/payout-reconciler.js";
import { PayoutRelayer } from "../src/payout-relayer.js";
import { loadPayoutRoleConfig } from "../src/payout-roles.js";
import { loadOperatorSettings, loadRelayerSettings } from "../src/payout-role-wiring.js";
import type { PayoutAttemptView, PayoutView } from "../src/payout-status.js";

const CHAIN = 46630n;
const TOKEN = "0x2626664c2603336e57b271c5c0b26f421741e481";
const SENDER = "0x1111111111111111111111111111111111111111";
const DEST = "0x000000000000000000000000000000000000dead";
const AMOUNT = 1_000_000n;
const NONCE = 7n;
const bytes = (h: string): number[] => [...fromHex(h)];
const word = (h: string): string => `0x${h.replace(/^0x/, "").padStart(64, "0")}`;

function signed(fee: bigint) {
  const raw = encodeTx(
    { chainId: CHAIN, nonce: NONCE, maxPriorityFeePerGas: fee, maxFeePerGas: fee, gasLimit: 120_000n, to: TOKEN, value: 0n, data: encodeTransfer(DEST, AMOUNT) },
    { yParity: 1, r: new Uint8Array(32).fill(1), s: new Uint8Array(32).fill(2) },
  );
  return { raw, hash: txHash(raw) };
}

const attempt = (fee: bigint, state: PayoutAttemptView["state"]): PayoutAttemptView => ({ tx_hash: bytes(signed(fee).hash), max_fee_per_gas: fee.toString(), state });

function payout(state: PayoutView["state"], attempts: PayoutAttemptView[], id = 1): PayoutView {
  return {
    backing: "backing.testnet", holder: "alice.testnet", request_id: Array(32).fill(id), state, reason: null, terminal: false,
    chain_id: CHAIN.toString(), token: bytes(TOKEN), sender: bytes(SENDER), destination: bytes(DEST), amount: AMOUNT.toString(),
    path: "custody-1", nonce: NONCE.toString(), binding_hash: Array(32).fill(9), attempts, evidence_hash: null,
  };
}

class FakeLedger implements PayoutLedger {
  readonly writes: string[] = [];
  constructor(readonly payouts: PayoutView[]) {}
  async listOpenPayouts(): Promise<PayoutView[]> {
    return structuredClone(this.payouts.filter((p) => !p.terminal));
  }
  async getSignedTransaction(_p: PayoutView, h: Hash): Promise<string | null> {
    return [signed(100n), signed(200n)].find((s) => s.hash === `0x${Buffer.from(h).toString("hex")}`)?.raw ?? null;
  }
  async recordBroadcast(): Promise<void> {
    this.writes.push("record_broadcast");
  }
  async recordPendingFinality(): Promise<void> {
    this.writes.push("record_pending_finality");
  }
  async requireReconciliation(): Promise<void> {
    this.writes.push("require_reconciliation");
  }
}

class FakeChain implements PayoutChainReader {
  finalized = { number: 100n, hash: `0x${"ab".repeat(32)}` };
  finalizedNonce = NONCE;
  pendingNonce = NONCE;
  readonly receipts = new Map<string, EvmReceipt>();
  failFinalized = false;
  async chainId() { return CHAIN; }
  async getFinalizedBlock() { if (this.failFinalized) throw new Error("rpc down"); return this.finalized; }
  async getBlockHash(n: bigint) { return [...this.receipts.values()].find((r) => r.blockNumber === n)?.blockHash ?? null; }
  async getTransactionCount(_a: string, tag: "pending" | "latest" | "finalized") { return tag === "finalized" ? this.finalizedNonce : this.pendingNonce; }
  async getTransactionReceipt(h: string) { return this.receipts.get(h) ?? null; }
  async isTransactionKnown(h: string) { return this.receipts.has(h); }
  async sendRawTransaction(raw: string) { return txHash(raw.replace(/^0x/, "")); }
  receipt(hash: string, over: { status?: boolean; amount?: bigint } = {}) {
    const ok = over.status ?? true;
    this.receipts.set(hash, {
      transactionHash: hash, status: ok, blockNumber: 90n, blockHash: `0x${"cd".repeat(32)}`,
      logs: ok ? [{ address: TOKEN, topics: [TRANSFER_TOPIC, word(SENDER), word(DEST)], data: word((over.amount ?? AMOUNT).toString(16)), logIndex: 3 }] : [],
    });
  }
}

const hex = (h: Hash) => `0x${Buffer.from(h).toString("hex")}`;

describe("role config separation", () => {
  const base = { PAYOUT_CONTRACT_ID: "payout.testnet", PAYOUT_EVM_RPC_URL: "https://rpc.example", PAYOUT_CHAIN_ID: "46630" };
  const relayer = { ...base, PAYOUT_RELAYER_ACCOUNT_ID: "relayer.testnet", PAYOUT_RELAYER_PRIVATE_KEY: "ed25519:relayer-fixture" };
  const operator = { ...base, PAYOUT_OPERATOR_ACCOUNT_ID: "operator.testnet", PAYOUT_OPERATOR_PRIVATE_KEY: "ed25519:operator-fixture" };

  it("loads each role from its own variables", () => {
    expect(loadPayoutRoleConfig("RELAYER", relayer)).toMatchObject({ role: "RELAYER", accountId: "relayer.testnet", chainId: 46630n });
    expect(loadPayoutRoleConfig("OPERATOR", operator)).toMatchObject({ role: "OPERATOR", accountId: "operator.testnet" });
  });

  it("refuses to start when the other role's credentials or the arena agent key are present, without echoing a value", () => {
    for (const extra of [operator, { PAYOUT_OPERATOR_PRIVATE_KEY_FILE: "/run/secrets/op" }, { AGENT_PRIVATE_KEY: "ed25519:agent-secret" }]) {
      let message = "";
      try { loadPayoutRoleConfig("RELAYER", { ...relayer, ...extra }); } catch (e) { message = (e as Error).message; }
      expect(message).toMatch(/must not be set in the payout relayer process/);
      expect(message).not.toMatch(/secret|fixture/);
    }
    expect(() => loadPayoutRoleConfig("OPERATOR", { ...operator, PAYOUT_RELAYER_PRIVATE_KEY: "ed25519:x" })).toThrow(/operator process/);
  });

  it("validates the rest of the config", () => {
    expect(() => loadPayoutRoleConfig("RELAYER", { ...relayer, PAYOUT_EVM_RPC_URL: "http://x" })).toThrow(/https/);
    expect(() => loadPayoutRoleConfig("RELAYER", { ...relayer, PAYOUT_CHAIN_ID: "0" })).toThrow(/PAYOUT_CHAIN_ID/);
    expect(() => loadPayoutRoleConfig("RELAYER", { ...relayer, PAYOUT_RELAYER_PRIVATE_KEY: "nope" })).toThrow(/ed25519/);
    expect(() => loadPayoutRoleConfig("RELAYER", { ...base, PAYOUT_RELAYER_ACCOUNT_ID: "r.testnet" })).toThrow(/missing key/);
    expect(() => loadRelayerSettings({})).toThrow(/MAX_FEE/);
    expect(loadRelayerSettings({ PAYOUT_RELAYER_MAX_FEE_PER_GAS_WEI: "100" }).maxFeePerGas).toBe(100n);
    expect(loadOperatorSettings({}).submit).toBe(false);
    expect(loadOperatorSettings({ PAYOUT_OPERATOR_SUBMIT: "true" }).submit).toBe(true);
    expect(() => loadOperatorSettings({ PAYOUT_OPERATOR_SUBMIT: "yes" })).toThrow(/true.*false/);
  });
});

describe("transport role boundary", () => {
  it("relayer ledger has no operator methods and the operator ledger has no relayer methods", () => {
    const relayerMethods = Object.getOwnPropertyNames(NearPayoutLedger.prototype);
    for (const m of ["confirmPayout", "recordRevert", "restorePayout"]) expect(relayerMethods).not.toContain(m);
    const operatorMethods = Object.getOwnPropertyNames(NearPayoutOperatorLedger.prototype);
    for (const m of ["recordBroadcast", "recordPendingFinality", "requireReconciliation", "requestSignature"]) expect(operatorMethods).not.toContain(m);
  });

  it("request_signature carries only the reservation identity and a fee cap with one yocto", async () => {
    const calls: unknown[][] = [];
    const t = { view: async () => undefined, call: async (...a: unknown[]) => void calls.push(a) } as unknown as NearTransport;
    const p = payout("authorized", []);
    await requestPayoutSignature(t, "payout.testnet", p, 123n);
    expect(calls[0]).toEqual(["payout.testnet", "request_signature", { backing: p.backing, holder: p.holder, request_id: p.request_id, max_fee_per_gas: "123" }, "300 Tgas", "1 yocto"]);
  });
});

function relayerSetup(payouts: PayoutView[], over: { chain?: FakeChain; fail?: boolean; chainId?: bigint } = {}) {
  const ledger = new FakeLedger(payouts);
  const chain = over.chain ?? new FakeChain();
  const requests: bigint[] = [];
  const signer = {
    requestSignature: async (p: PayoutView, fee: bigint) => {
      requests.push(fee);
      // Like the contract: the attempt is stored before any answer, so the next view shows signing_requested.
      const stored = payouts.find((x) => x.request_id[0] === p.request_id[0]) as PayoutView;
      stored.state = "signing_requested";
      stored.attempts = [{ tx_hash: Array(32).fill(0), max_fee_per_gas: fee.toString(), state: "requested" }];
      if (over.fail) throw new Error("response lost");
    },
  };
  const relayer = new PayoutRelayer(new PayoutReconciler(ledger, chain, { signingGraceMs: 60_000 }), ledger, signer, chain, { chainId: over.chainId ?? CHAIN, maxFeePerGas: 500n });
  return { relayer, ledger, requests, chain };
}

describe("PayoutRelayer signature initiation", () => {
  it("requests exactly one signature for a cleared authorized payout and never again after a restart", async () => {
    const { relayer, requests } = relayerSetup([payout("authorized", [])]);
    expect(await relayer.pass()).toMatchObject({ requested: 1, errors: 0 });
    expect(requests).toEqual([500n]);
    // A second pass (or a restarted worker) sees signing_requested and does not request again.
    expect(await relayer.pass()).toMatchObject({ requested: 0 });
    expect(requests).toHaveLength(1);
    expect(relayer.status()).toMatchObject({ role: "relayer", lastReport: { requested: 0 } });
  });

  it("a lost response is an error, not a retry, and the next pass does not allocate another spend", async () => {
    const { relayer, requests } = relayerSetup([payout("authorized", [])], { fail: true });
    expect(await relayer.pass()).toMatchObject({ requested: 0, errors: 1 });
    expect(await relayer.pass()).toMatchObject({ requested: 0, errors: 0 });
    expect(requests).toHaveLength(1);
  });

  it("does not request for a payout that is not clean, on the wrong chain, or when reconciliation fails", async () => {
    const withAttempt = payout("authorized", [attempt(100n, "signed")], 2);
    const wrongChain = { ...payout("authorized", [], 3), chain_id: "1" };
    const a = relayerSetup([withAttempt, wrongChain]);
    const report = await a.relayer.pass();
    expect(a.requests).toEqual([]);
    expect(report.skipped.map((s) => s.reason)).toEqual(expect.arrayContaining(["already has attempts"]));
    expect(report.skipped.length + report.errors).toBeGreaterThan(0);

    const chain = new FakeChain();
    chain.failFinalized = true;
    const b = relayerSetup([payout("authorized", [], 4)], { chain });
    const failed = await b.relayer.pass();
    expect(b.requests).toEqual([]);
    expect(failed.errors).toBeGreaterThan(0);
  });

  it("does not request when the nonce slot is already used on chain", async () => {
    const chain = new FakeChain();
    chain.pendingNonce = NONCE + 1n;
    const { relayer, requests } = relayerSetup([payout("authorized", [])], { chain });
    await relayer.pass();
    expect(requests).toEqual([]);
  });
});

function recordingSubmitter(failOn?: string) {
  const calls: string[] = [];
  const s: OperatorSubmitter = {
    confirmPayout: async () => { if (failOn === "confirm_payout") throw new Error("timeout"); calls.push("confirm_payout"); },
    recordRevert: async () => { if (failOn === "record_revert") throw new Error("timeout"); calls.push("record_revert"); },
    restorePayout: async () => { if (failOn === "restore_payout") throw new Error("timeout"); calls.push("restore_payout"); },
  };
  return { s, calls };
}

/** The operator's reconciler gets a ledger whose relayer writes throw, exactly like the production wiring. */
function operatorSetup(payouts: PayoutView[], chain: FakeChain, submit: boolean, failOn?: string) {
  const ledger = new FakeLedger(payouts);
  const readOnly: PayoutLedger = {
    listOpenPayouts: () => ledger.listOpenPayouts(),
    getSignedTransaction: (p, h) => ledger.getSignedTransaction(p, h),
    recordBroadcast: async () => { throw new Error("relayer method"); },
    recordPendingFinality: async () => { throw new Error("relayer method"); },
    requireReconciliation: async () => { throw new Error("relayer method"); },
  };
  const { s, calls } = recordingSubmitter(failOn);
  return { operator: new PayoutOperator(new PayoutReconciler(readOnly, chain), ledger, s, { submit }), calls, ledger };
}

describe("PayoutOperator finalized evidence", () => {
  it("confirms only after the finalized exact transfer is re-checked, and only when submitting is enabled", async () => {
    const a = attempt(100n, "pending");
    const chain = new FakeChain();
    chain.receipt(hex(a.tx_hash));
    const dry = operatorSetup([payout("pending_finality", [a])], chain, false);
    expect(await dry.operator.pass()).toMatchObject({ results: [{ kind: "dry_run", calls: ["confirm_payout"] }], errors: 0 });
    expect(dry.calls).toEqual([]);

    const live = operatorSetup([payout("pending_finality", [a])], chain, true);
    expect(await live.operator.pass()).toMatchObject({ results: [{ kind: "submitted", calls: ["confirm_payout"] }] });
    expect(live.calls).toEqual(["confirm_payout"]);
  });

  it("never confirms wrong or partial transfer evidence", async () => {
    const a = attempt(100n, "pending");
    const chain = new FakeChain();
    chain.receipt(hex(a.tx_hash), { amount: AMOUNT - 1n });
    const run = operatorSetup([payout("pending_finality", [a])], chain, true);
    const report = await run.operator.pass();
    expect(run.calls).toEqual([]);
    expect(report.results.filter((r) => r.kind === "submitted")).toEqual([]);
  });

  it("a failed or timed-out call leaves the payout open and is reported, not treated as success", async () => {
    const a = attempt(100n, "pending");
    const chain = new FakeChain();
    chain.receipt(hex(a.tx_hash));
    const run = operatorSetup([payout("pending_finality", [a])], chain, true, "confirm_payout");
    expect(await run.operator.pass()).toMatchObject({ results: [{ kind: "failed", submitted: [] }], errors: 1 });
    expect(run.ledger.payouts[0]?.terminal).toBe(false);
  });

  it("records the reverts and restores only once the nonce slot is finalized past the payout", async () => {
    const a = attempt(100n, "pending");
    const chain = new FakeChain();
    chain.receipt(hex(a.tx_hash), { status: false });
    chain.finalizedNonce = NONCE; // slot not finalized yet: nothing to do
    const early = operatorSetup([payout("pending_finality", [a])], chain, true);
    await early.operator.pass();
    expect(early.calls).toEqual([]);

    chain.finalizedNonce = NONCE + 1n;
    const ready = operatorSetup([payout("pending_finality", [a])], chain, true);
    expect(await ready.operator.pass()).toMatchObject({ results: [{ kind: "submitted", calls: ["record_revert", "restore_payout"] }] });
    expect(ready.calls).toEqual(["record_revert", "restore_payout"]);
  });
});

describe("checkOperatorProof refuses tampered or mismatched proofs", () => {
  const a = attempt(100n, "pending");
  const p = payout("pending_finality", [a]);
  const base = {
    chain_id: p.chain_id, token: p.token, sender: p.sender, recipient: p.destination, amount: p.amount, tx_hash: a.tx_hash,
    log_index: 3, block_hash: Array(32).fill(5), block_number: "90", finalized_head_number: "100", finalized_head_hash: Array(32).fill(6),
  };
  const confirm = (over: Record<string, unknown> = {}, rehash = true): OperatorProof => {
    const e = { ...base, ...over } as typeof base;
    return { calls: [{ method: "confirm_payout", evidence: { ...e, evidence_hash: rehash ? evidenceHash(e) : Array(32).fill(1) } }], facts: {} };
  };

  it("accepts the exact proof", () => expect(checkOperatorProof(p, confirm())).toBeNull());

  it.each([
    ["another amount", { amount: (AMOUNT + 1n).toString() }, /amount/],
    ["another recipient", { recipient: bytes("0x000000000000000000000000000000000000beef") }, /recipient/],
    ["another chain", { chain_id: "1" }, /chain/],
    ["an unknown transaction", { tx_hash: Array(32).fill(8) }, /recorded attempt/],
    ["a block above the finalized head", { block_number: "101" }, /finalized head/],
  ])("refuses evidence with %s", (_n, over, re) => expect(checkOperatorProof(p, confirm(over))).toMatch(re));

  it("refuses an evidence hash that does not recompute, a terminal payout and an unconfirmable state", () => {
    expect(checkOperatorProof(p, confirm({}, false))).toMatch(/hash/);
    expect(checkOperatorProof({ ...p, terminal: true }, confirm())).toMatch(/terminal/);
    expect(checkOperatorProof({ ...p, state: "authorized" }, confirm())).toMatch(/not confirmable/);
  });

  it("refuses a restore that skips an attempt, uses a slot not finalized or names another sender", () => {
    const b = attempt(200n, "pending");
    const two = payout("pending_finality", [a, b]);
    const restore = (over: Record<string, unknown> = {}, reverts: Hash[] = [a.tx_hash]): OperatorProof => ({
      calls: [
        ...reverts.map((h) => ({ method: "record_revert" as const, tx_hash: h })),
        { method: "restore_payout", proof: { chain_id: p.chain_id, sender: p.sender, finalized_nonce: (NONCE + 1n).toString(), outcome: { OurTxReverted: a.tx_hash }, finalized_head_number: "100", finalized_head_hash: Array(32).fill(6), ...over } },
      ],
      facts: {},
    });
    expect(checkOperatorProof(p, restore())).toBeNull();
    expect(checkOperatorProof(two, restore())).toMatch(/not proven reverted/);
    expect(checkOperatorProof(two, restore({}, [a.tx_hash, b.tx_hash]))).toBeNull();
    expect(checkOperatorProof(p, restore({ finalized_nonce: NONCE.toString() }))).toMatch(/not finalized/);
    expect(checkOperatorProof(p, restore({ sender: bytes("0x2222222222222222222222222222222222222222") }))).toMatch(/sender/);
  });
});
