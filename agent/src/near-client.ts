import { Near } from "near-kit";
import type { ArenaClient } from "./client.js";
import type { AgentConfig } from "./config.js";
import type { BattleView, ConfigView, SettlementStep } from "./types.js";

/** Minimal surface of near-kit that the client needs; lets tests stub the transport. */
export interface NearTransport {
  view<T>(contractId: string, method: string, args: object): Promise<T | undefined>;
  call(contractId: string, method: string, args: object, gas: string): Promise<unknown>;
}

const AGENT_CALL_GAS = "100 Tgas";

export function createNearTransport(cfg: AgentConfig): NearTransport {
  const near = new Near({
    network: cfg.network,
    rpcUrl: cfg.rpcUrl,
    privateKey: cfg.agentPrivateKey as `ed25519:${string}`,
    defaultSignerId: cfg.agentAccountId,
  });
  return {
    view: (contractId, method, args) => near.view(contractId, method, args),
    call: (contractId, method, args, gas) =>
      near.call(contractId, method, args, { gas: gas as never, signerId: cfg.agentAccountId }),
  };
}

/** ArenaClient backed by a real NEAR RPC endpoint. u128 values are sent as strings. */
export class NearArenaClient implements ArenaClient {
  constructor(
    private readonly contractId: string,
    private readonly transport: NearTransport,
  ) {}

  static fromConfig(cfg: AgentConfig): NearArenaClient {
    return new NearArenaClient(cfg.arenaContractId, createNearTransport(cfg));
  }

  private async view<T>(method: string, args: object = {}): Promise<T> {
    const res = await this.transport.view<T>(this.contractId, method, args);
    return res as T;
  }

  private async change(method: string, args: object): Promise<void> {
    await this.transport.call(this.contractId, method, args, AGENT_CALL_GAS);
  }

  async getBattle(battleId: number): Promise<BattleView | null> {
    return (await this.view<BattleView | null>("get_battle", { battle_id: battleId })) ?? null;
  }

  async getBattles(fromIndex: number, limit: number): Promise<BattleView[]> {
    return (
      (await this.view<BattleView[]>("get_battles", { from_index: fromIndex, limit })) ?? []
    );
  }

  async getBattleCount(): Promise<number> {
    return Number(await this.view<number | string>("get_battle_count"));
  }

  getConfig(): Promise<ConfigView> {
    return this.view<ConfigView>("get_config");
  }

  async getSettlementPlan(battleId: number): Promise<SettlementStep[]> {
    return (
      (await this.view<SettlementStep[]>("get_settlement_plan", { battle_id: battleId })) ?? []
    );
  }

  approveBattle(battleId: number): Promise<void> {
    return this.change("approve_battle", { battle_id: battleId });
  }

  voidBattle(battleId: number, reason: string): Promise<void> {
    return this.change("void_battle", { battle_id: battleId, reason });
  }

  setInitialPrices(battleId: number, priceA: bigint, priceB: bigint): Promise<void> {
    return this.change("set_initial_prices", {
      battle_id: battleId,
      price_a: priceA.toString(),
      price_b: priceB.toString(),
    });
  }

  settleBattle(battleId: number, finalPriceA: bigint, finalPriceB: bigint): Promise<void> {
    return this.change("settle_battle", {
      battle_id: battleId,
      final_price_a: finalPriceA.toString(),
      final_price_b: finalPriceB.toString(),
    });
  }

  reportExecution(battleId: number, stepIndex: number, realizedAmount: bigint): Promise<void> {
    return this.change("report_execution", {
      battle_id: battleId,
      step_index: stepIndex,
      realized_amount: realizedAmount.toString(),
    });
  }

  emergencyHalt(battleId: number, reason: string): Promise<void> {
    return this.change("emergency_halt", { battle_id: battleId, reason });
  }
}
