import type { BattleView, ConfigView, SettlementStep } from "./types.js";

/**
 * Chain access used by the agent: contract views plus the agent-only change
 * methods. All u128 values are bigint here and are encoded as decimal strings
 * on the wire by implementations.
 */
export interface ArenaClient {
  getBattle(battleId: number): Promise<BattleView | null>;
  getBattles(fromIndex: number, limit: number): Promise<BattleView[]>;
  getBattleCount(): Promise<number>;
  getConfig(): Promise<ConfigView>;
  getSettlementPlan(battleId: number): Promise<SettlementStep[]>;

  approveBattle(battleId: number): Promise<void>;
  voidBattle(battleId: number, reason: string): Promise<void>;
  setInitialPrices(battleId: number, priceA: bigint, priceB: bigint): Promise<void>;
  settleBattle(battleId: number, finalPriceA: bigint, finalPriceB: bigint): Promise<void>;
  reportExecution(battleId: number, stepIndex: number, realizedAmount: bigint): Promise<void>;
  /** On-chain execution: dispatch (or book, for Return/zero steps) one plan step. */
  executeStep(battleId: number, stepIndex: number, minOut: bigint): Promise<void>;
  emergencyHalt(battleId: number, reason: string): Promise<void>;
}

const PAGE_SIZE = 50;

/** Read every battle from chain, ascending by id. */
export async function fetchAllBattles(
  client: ArenaClient,
  pageSize: number = PAGE_SIZE,
): Promise<BattleView[]> {
  const count = await client.getBattleCount();
  const out: BattleView[] = [];
  for (let from = 0; from < count; from += pageSize) {
    const page = await client.getBattles(from, pageSize);
    out.push(...page);
    if (page.length === 0) break;
  }
  return out;
}
