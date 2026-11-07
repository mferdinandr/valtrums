import { Near } from "near-kit";
import type { ArenaClient } from "./client.js";
import { withViewRetries } from "./rpc-resilience.js";
import type { AgentConfig } from "./config.js";
import type {
  BattleView,
  ConfigView,
  ForeignCall,
  ForeignConfigView,
  ForeignTxParams,
  SettlementStep,
  SignRequestView,
} from "./types.js";

/** Minimal surface of near-kit that the client needs; lets tests stub the transport. */
export interface NearTransport {
  view<T>(contractId: string, method: string, args: object): Promise<T | undefined>;
  call(
    contractId: string,
    method: string,
    args: object,
    gas: string,
    attachedDeposit?: string,
  ): Promise<unknown>;
}

const AGENT_CALL_GAS = "100 Tgas";
/**
 * execute_step starts a swap that runs through the adapter, the exchange and back to
 * the arena, so it gets the largest budget a transaction can carry (unused gas is
 * refunded). 200 Tgas was not enough for that chain: the step was rolled back.
 */
const EXECUTE_STEP_GAS = "300 Tgas";
/** request_signature / retry_signature call the MPC signer (about 280 Tgas needed). */
const SIGN_GAS = "300 Tgas";

function wireCall(call: ForeignCall): object {
  switch (call.kind) {
    case "approve":
      return { kind: "approve", token: call.token, spender: call.spender, amount: call.amount.toString() };
    case "transfer":
      return { kind: "transfer", token: call.token, to: call.to, amount: call.amount.toString() };
    case "swap_exact_in":
      return {
        kind: "swap_exact_in",
        token_in: call.token_in,
        token_out: call.token_out,
        fee: call.fee,
        recipient: call.recipient,
        amount_in: call.amount_in.toString(),
        min_out: call.min_out.toString(),
      };
  }
}

export function createNearTransport(cfg: AgentConfig): NearTransport {
  const near = new Near({
    network: cfg.network,
    rpcUrl: cfg.rpcUrl,
    privateKey: cfg.agentPrivateKey as `ed25519:${string}`,
    defaultSignerId: cfg.agentAccountId,
  });
  return withViewRetries({
    view: (contractId, method, args) => near.view(contractId, method, args),
    call: (contractId, method, args, gas, attachedDeposit) =>
      near.call(contractId, method, args, {
        gas: gas as never,
        signerId: cfg.agentAccountId,
        ...(attachedDeposit ? { attachedDeposit: attachedDeposit as never } : {}),
      }),
  });
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

  private async change(method: string, args: object, gas: string = AGENT_CALL_GAS): Promise<void> {
    await this.transport.call(this.contractId, method, args, gas);
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

  executeStep(battleId: number, stepIndex: number, minOut: bigint): Promise<void> {
    return this.change(
      "execute_step",
      { battle_id: battleId, step_index: stepIndex, min_out: minOut.toString() },
      EXECUTE_STEP_GAS,
    );
  }

  emergencyHalt(battleId: number, reason: string): Promise<void> {
    return this.change("emergency_halt", { battle_id: battleId, reason });
  }

  async getForeignConfig(): Promise<ForeignConfigView | null> {
    return (await this.view<ForeignConfigView | null>("get_foreign_config")) ?? null;
  }

  async getSignatureRequest(requestId: number): Promise<SignRequestView | null> {
    return (
      (await this.view<SignRequestView | null>("get_signature_request", { request_id: requestId })) ?? null
    );
  }

  async getSignatureRequestCount(): Promise<number> {
    return Number(await this.view<number | string>("get_signature_request_count"));
  }

  /**
   * The transport does not expose transaction logs, so the new request id is the
   * count right after the call, checked against the request's battle and step. If
   * another request slipped in between, this throws and the executor finds the
   * request by scanning on its next pass.
   */
  async requestSignature(
    battleId: number,
    call: ForeignCall,
    params: ForeignTxParams,
    stepIndex: number | null,
  ): Promise<number> {
    await this.change(
      "request_signature",
      {
        battle_id: battleId,
        call: wireCall(call),
        params: {
          nonce: params.nonce.toString(),
          max_priority_fee_per_gas: params.maxPriorityFeePerGas.toString(),
          max_fee_per_gas: params.maxFeePerGas.toString(),
          gas_limit: params.gasLimit.toString(),
        },
        step_index: stepIndex,
      },
      SIGN_GAS,
    );
    const id = await this.getSignatureRequestCount();
    const request = await this.getSignatureRequest(id);
    if (!request || request.battle_id !== battleId || request.step_index !== stepIndex) {
      throw new Error("could not identify the new signature request");
    }
    return id;
  }

  async retrySignature(requestId: number): Promise<void> {
    await this.change("retry_signature", { request_id: requestId }, SIGN_GAS);
  }
}
