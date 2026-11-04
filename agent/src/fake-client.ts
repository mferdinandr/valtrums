import type { ArenaClient } from "./client.js";
import type { BattleStatus, BattleView, ConfigView, SettlementStep } from "./types.js";

export type RecordedCall =
  | { method: "approve_battle"; battleId: number }
  | { method: "void_battle"; battleId: number; reason: string }
  | { method: "set_initial_prices"; battleId: number; priceA: bigint; priceB: bigint }
  | { method: "settle_battle"; battleId: number; priceA: bigint; priceB: bigint }
  | { method: "report_execution"; battleId: number; stepIndex: number; realized: bigint }
  | { method: "emergency_halt"; battleId: number; reason: string };

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
    this.plans.set(
      battleId,
      this.planTemplate.map(([kind, amount], index) => ({
        index,
        kind,
        amount,
        done: false,
        realized: null,
      })),
    );
    this.calls.push({ method: "settle_battle", battleId, priceA, priceB });
  }

  async reportExecution(battleId: number, stepIndex: number, realized: bigint): Promise<void> {
    const b = this.require(battleId, ["Settling"]);
    const step = this.plans.get(battleId)?.[stepIndex];
    if (!step) throw new Error(`battle ${battleId} has no step ${stepIndex}`);
    if (step.done) throw new Error(`step ${stepIndex} of battle ${battleId} already reported`);
    step.done = true;
    step.realized = realized.toString();
    if (this.plans.get(battleId)!.every((s) => s.done)) b.status = "Settled";
    this.calls.push({ method: "report_execution", battleId, stepIndex, realized });
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
