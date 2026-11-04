import type { ArenaClient } from "./client.js";
import {
  encodeApprove,
  encodeExactInputSingle,
  encodeTransfer,
  fromHex,
  normalizeAddress,
} from "./evm-abi.js";
import { decodeTx, encodeTx, txHash } from "./evm-tx.js";
import type {
  BattleStatus,
  BattleView,
  ConfigView,
  ForeignCall,
  ForeignConfigView,
  ForeignTxParams,
  SettlementStep,
  SignRequestView,
} from "./types.js";

export type RecordedCall =
  | { method: "approve_battle"; battleId: number }
  | { method: "void_battle"; battleId: number; reason: string }
  | { method: "set_initial_prices"; battleId: number; priceA: bigint; priceB: bigint }
  | { method: "settle_battle"; battleId: number; priceA: bigint; priceB: bigint }
  | { method: "report_execution"; battleId: number; stepIndex: number; realized: bigint }
  | { method: "execute_step"; battleId: number; stepIndex: number; minOut: bigint }
  | { method: "emergency_halt"; battleId: number; reason: string }
  | { method: "request_signature"; battleId: number; stepIndex: number | null; call: ForeignCall }
  | { method: "retry_signature"; requestId: number };

/**
 * In-memory ArenaClient for tests. It enforces the same status preconditions as
 * the contract so that duplicate actions fail loudly instead of silently passing.
 */
export class FakeArenaClient implements ArenaClient {
  readonly calls: RecordedCall[] = [];
  private readonly battles = new Map<number, BattleView>();
  private readonly plans = new Map<number, SettlementStep[]>();
  /** Steps `settle_battle` creates, as [kind, amount] pairs. */
  planTemplate: Array<[SettlementStep["kind"], string]> = [
    ["Dump", "100"],
    ["Buy", "90"],
    ["Burn", "4"],
  ];

  /** Set to enable on-chain execution (the contract's `set_execution`). */
  executionDex: string | null = null;
  burnAccount: string | null = null;
  /**
   * When true, `settle_battle` stores only the first template step and the rest
   * is appended once it is done, like the real contract does after the Dump.
   */
  lazyPlan = false;
  private readonly tails = new Map<number, SettlementStep[]>();
  private readonly minOuts = new Map<string, bigint>();

  /** Foreign signing config (`set_foreign`); null means not configured. */
  foreign: ForeignConfigView | null = null;
  /** Address the fake signer "controls" per path; the fake signature carries it in `r`. */
  signerAddress: (path: string) => string = () => "0x" + "ab".repeat(20);
  /** Sign requests as soon as they are made. When false, call `signPending` to answer them. */
  autoSign = true;
  /** The next signer answers fail (consumed one per attempt). */
  failSignatures = 0;
  readonly maxSignAttempts = 5;
  private readonly signRequests = new Map<number, SignRequestView & { yParityFields: ForeignCall }>();
  private signCount = 0;

  /** Turn on-chain execution on (or off with nulls). */
  setExecution(dex: string | null, burn: string | null): void {
    this.executionDex = dex;
    this.burnAccount = burn;
  }

  constructor(battles: BattleView[] = []) {
    for (const b of battles) this.battles.set(b.id, { ...b });
  }

  put(battle: BattleView): void {
    this.battles.set(battle.id, { ...battle });
  }

  status(battleId: number): BattleStatus | undefined {
    return this.battles.get(battleId)?.status;
  }

  async getBattle(battleId: number): Promise<BattleView | null> {
    const b = this.battles.get(battleId);
    return b ? { ...b } : null;
  }

  async getBattles(fromIndex: number, limit: number): Promise<BattleView[]> {
    return [...this.battles.values()]
      .sort((x, y) => x.id - y.id)
      .slice(fromIndex, fromIndex + limit)
      .map((b) => ({ ...b }));
  }

  async getBattleCount(): Promise<number> {
    return this.battles.size;
  }

  async getConfig(): Promise<ConfigView> {
    return {
      owner: "owner.testnet",
      usdc: "usdc.testnet",
      treasury: "treasury.testnet",
      bond: "1000000",
      agents: ["agent.testnet"],
      paused: false,
      execution_dex: this.executionDex,
      burn_account: this.burnAccount,
    };
  }

  async getSettlementPlan(battleId: number): Promise<SettlementStep[]> {
    return (this.plans.get(battleId) ?? []).map((s) => ({ ...s }));
  }

  /** Install a plan directly, for tests that start mid-settlement. */
  putPlan(battleId: number, steps: SettlementStep[]): void {
    this.plans.set(battleId, steps.map((s) => ({ ...s })));
  }

  private require(battleId: number, expected: BattleStatus[]): BattleView {
    const b = this.battles.get(battleId);
    if (!b) throw new Error(`battle ${battleId} not found`);
    if (!expected.includes(b.status)) {
      throw new Error(`battle ${battleId} has status ${b.status}, expected ${expected.join("|")}`);
    }
    return b;
  }

  async approveBattle(battleId: number): Promise<void> {
    const b = this.require(battleId, ["Proposed"]);
    b.status = "Approved";
    this.calls.push({ method: "approve_battle", battleId });
  }

  async voidBattle(battleId: number, reason: string): Promise<void> {
    const b = this.require(battleId, ["Proposed", "Approved"]);
    b.status = "Voided";
    this.calls.push({ method: "void_battle", battleId, reason });
  }

  async setInitialPrices(battleId: number, priceA: bigint, priceB: bigint): Promise<void> {
    const b = this.require(battleId, ["Approved"]);
    b.status = "Live";
    b.initial_price_a = priceA.toString();
    b.initial_price_b = priceB.toString();
    this.calls.push({ method: "set_initial_prices", battleId, priceA, priceB });
  }

  async settleBattle(battleId: number, priceA: bigint, priceB: bigint): Promise<void> {
    const b = this.require(battleId, ["Live"]);
    b.status = "Settling";
    b.final_price_a = priceA.toString();
    b.final_price_b = priceB.toString();
    if (b.initial_price_a !== null && b.initial_price_b !== null) {
      // Relative performance: final/initial, compared without division.
      const a = priceA * BigInt(b.initial_price_b);
      const bb = priceB * BigInt(b.initial_price_a);
      b.winner = a > bb ? "A" : a < bb ? "B" : b.winner;
    }
    const steps = this.planTemplate.map(
      ([kind, amount], index): SettlementStep => ({
        index,
        kind,
        amount,
        done: false,
        dispatched: false,
        realized: null,
      }),
    );
    if (this.lazyPlan) {
      this.plans.set(battleId, steps.slice(0, 1));
      this.tails.set(battleId, steps.slice(1));
    } else {
      this.plans.set(battleId, steps);
    }
    this.calls.push({ method: "settle_battle", battleId, priceA, priceB });
  }

  /** Mark a step done; appends the lazy tail after the first step and settles when complete. */
  private finishStep(battleId: number, step: SettlementStep, realized: bigint): void {
    step.done = true;
    step.dispatched = false;
    step.realized = realized.toString();
    const plan = this.plans.get(battleId)!;
    const tail = this.tails.get(battleId);
    if (tail && step.index === 0) {
      plan.push(...tail);
      this.tails.delete(battleId);
    }
    if (!this.tails.has(battleId) && plan.every((s) => s.done)) {
      this.battles.get(battleId)!.status = "Settled";
    }
  }

  async reportExecution(battleId: number, stepIndex: number, realized: bigint): Promise<void> {
    this.require(battleId, ["Settling"]);
    if (this.executionDex !== null) {
      throw new Error("report_execution is refused while on-chain execution is on");
    }
    const step = this.plans.get(battleId)?.[stepIndex];
    if (!step) throw new Error(`battle ${battleId} has no step ${stepIndex}`);
    if (step.done) throw new Error(`step ${stepIndex} of battle ${battleId} already reported`);
    this.finishStep(battleId, step, realized);
    this.calls.push({ method: "report_execution", battleId, stepIndex, realized });
  }

  async executeStep(battleId: number, stepIndex: number, minOut: bigint): Promise<void> {
    this.require(battleId, ["Settling"]);
    if (this.executionDex === null) throw new Error("on-chain execution is off");
    const plan = this.plans.get(battleId) ?? [];
    const step = plan[stepIndex];
    if (!step) throw new Error(`battle ${battleId} has no step ${stepIndex}`);
    if (step.done) throw new Error(`step ${stepIndex} of battle ${battleId} already done`);
    if (step.dispatched) throw new Error(`step ${stepIndex} of battle ${battleId} already dispatched`);
    if (plan.slice(0, stepIndex).some((s) => !s.done)) {
      throw new Error(`step ${stepIndex} of battle ${battleId} is out of order`);
    }
    this.calls.push({ method: "execute_step", battleId, stepIndex, minOut });
    const amount = BigInt(step.amount);
    if (step.kind === "Return" || amount === 0n) {
      this.finishStep(battleId, step, amount);
      return;
    }
    step.dispatched = true;
    this.minOuts.set(`${battleId}:${stepIndex}`, minOut);
  }

  /**
   * Test helper: the DEX pays `proceeds` for a dispatched step. Below the
   * dispatched `min_out` the payment is rejected and the step stays dispatched
   * (returns false); otherwise the step is booked (returns true).
   */
  completeDispatched(battleId: number, stepIndex: number, proceeds: bigint): boolean {
    const step = this.plans.get(battleId)?.[stepIndex];
    if (!step?.dispatched) throw new Error(`step ${stepIndex} of battle ${battleId} is not dispatched`);
    if (proceeds < (this.minOuts.get(`${battleId}:${stepIndex}`) ?? 0n)) return false;
    this.finishStep(battleId, step, proceeds);
    return true;
  }

  /** Test helper: the DEX refused the swap, so the step is dispatchable again. */
  refuseDispatched(battleId: number, stepIndex: number): void {
    const step = this.plans.get(battleId)?.[stepIndex];
    if (!step?.dispatched) throw new Error(`step ${stepIndex} of battle ${battleId} is not dispatched`);
    step.dispatched = false;
  }

  async getForeignConfig(): Promise<ForeignConfigView | null> {
    return this.foreign ? { ...this.foreign } : null;
  }

  async getSignatureRequest(requestId: number): Promise<SignRequestView | null> {
    const r = this.signRequests.get(requestId);
    if (!r) return null;
    const { yParityFields: _call, ...view } = r;
    return { ...view };
  }

  async getSignatureRequestCount(): Promise<number> {
    return this.signCount;
  }

  /** Mirrors the contract's checks: destinations, step fit, status. */
  async requestSignature(
    battleId: number,
    call: ForeignCall,
    params: ForeignTxParams,
    stepIndex: number | null,
  ): Promise<number> {
    const cfg = this.foreign;
    if (!cfg) throw new Error("Cross-chain signing is not configured");
    const battle = this.require(battleId, ["Approved", "Live", "Settling"]);
    const same = (a: string, b: string) => normalizeAddress(a) === normalizeAddress(b);
    if (stepIndex !== null) {
      if (battle.status !== "Settling") throw new Error("Steps can only be signed while settling");
      const step = this.plans.get(battleId)?.[stepIndex];
      if (!step) throw new Error("Unknown step");
      if (step.done) throw new Error("Step already reported");
      const ok =
        ((step.kind === "Dump" || step.kind === "Buy") && call.kind === "swap_exact_in") ||
        (step.kind === "Burn" && call.kind === "swap_exact_in" && same(call.recipient, cfg.burn)) ||
        (step.kind === "Return" && call.kind === "transfer" && same(call.to, cfg.treasury));
      if (!ok) throw new Error("Call does not fit this step");
    }
    let to: string;
    let data: string;
    if (call.kind === "approve") {
      if (!same(call.spender, cfg.router)) throw new Error("Approvals are only allowed for the router");
      to = call.token;
      data = encodeApprove(call.spender, call.amount);
    } else if (call.kind === "transfer") {
      if (!same(call.to, cfg.treasury) && !same(call.to, cfg.burn)) {
        throw new Error("Transfers are only allowed to the treasury or burn address");
      }
      to = call.token;
      data = encodeTransfer(call.to, call.amount);
    } else {
      to = cfg.router;
      data = encodeExactInputSingle({
        tokenIn: call.token_in,
        tokenOut: call.token_out,
        fee: call.fee,
        recipient: call.recipient,
        amountIn: call.amount_in,
        minOut: call.min_out,
      });
    }
    const unsigned = encodeTx({
      chainId: BigInt(cfg.chain_id),
      nonce: params.nonce,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      maxFeePerGas: params.maxFeePerGas,
      gasLimit: params.gasLimit,
      to,
      value: 0n,
      data,
    });
    const id = ++this.signCount;
    this.signRequests.set(id, {
      battle_id: battleId,
      step_index: stepIndex,
      path: `valtrum-battle-${battleId}`,
      status: "Pending",
      unsigned_tx: unsigned,
      payload_hash: "00".repeat(32),
      signed_tx: null,
      tx_hash: null,
      attempts: 0,
      yParityFields: call,
    });
    this.calls.push({ method: "request_signature", battleId, stepIndex, call });
    if (this.autoSign) this.answer(id);
    return id;
  }

  async retrySignature(requestId: number): Promise<void> {
    const r = this.signRequests.get(requestId);
    if (!r) throw new Error("Request not found");
    if (r.status !== "Failed") throw new Error("Only a failed request can be retried");
    if (r.attempts >= this.maxSignAttempts) throw new Error("Too many failed attempts");
    r.status = "Pending";
    this.calls.push({ method: "retry_signature", requestId });
    if (this.autoSign) this.answer(requestId);
  }

  /** Answer every pending request (the signer's asynchronous reply). */
  signPending(): void {
    for (const [id, r] of this.signRequests) if (r.status === "Pending") this.answer(id);
  }

  private answer(id: number): void {
    const r = this.signRequests.get(id)!;
    if (this.failSignatures > 0) {
      this.failSignatures--;
      r.attempts++;
      r.status = "Failed";
      return;
    }
    const sender = normalizeAddress(this.signerAddress(r.path)).slice(2);
    const body = r.unsigned_tx;
    const signed = signFake(body, sender);
    r.signed_tx = signed;
    r.tx_hash = txHash(signed).slice(2);
    r.status = "Signed";
  }

  async emergencyHalt(battleId: number, reason: string): Promise<void> {
    const b = this.require(battleId, ["Approved", "Live"]);
    b.status = "EmergencyHalted";
    this.calls.push({ method: "emergency_halt", battleId, reason });
  }
}

/** Build a BattleView with sensible defaults for tests. */
export function makeBattle(overrides: Partial<BattleView> & { id: number }): BattleView {
  return {
    creator: "creator.testnet",
    token_a: "aaa.testnet",
    token_b: "bbb.testnet",
    bond: "1000000",
    duration_ns: "86400000000000",
    deposit_deadline_ns: "1000",
    status: "Proposed",
    vault_a: "0",
    vault_b: "0",
    start_time_ns: "0",
    end_time_ns: "0",
    initial_price_a: null,
    initial_price_b: null,
    final_price_a: null,
    final_price_b: null,
    winner: null,
    ...overrides,
  };
}

/** Attach a fake signature whose `r` is the 32-byte left-padded sender address. */
function signFake(unsignedHex: string, senderHex: string): string {
  const tx = decodeTx(unsignedHex);
  return encodeTx(tx, {
    yParity: 0,
    r: fromHex(senderHex.padStart(64, "0")),
    s: fromHex("11".repeat(32)),
  });
}
