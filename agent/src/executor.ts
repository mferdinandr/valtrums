import type { BattleView, SettlementStep } from "./types.js";

/**
 * Carries out one settlement plan step and returns the amount actually
 * realized. Implementations must be safe to call again for the same step after
 * a crash (the runner only reports a step once the executor returned).
 */
export interface StepExecutor {
  execute(step: SettlementStep, battle: BattleView): Promise<bigint>;
}

/** Mock-execution mode: no foreign chain involved, the step is "realized" as planned. */
export class MockStepExecutor implements StepExecutor {
  constructor(
    private readonly realize: (step: SettlementStep, battle: BattleView) => bigint = (s) =>
      BigInt(s.amount),
  ) {}

  async execute(step: SettlementStep, battle: BattleView): Promise<bigint> {
    return this.realize(step, battle);
  }
}

/**
 * Extension point for signing and broadcasting steps on a foreign chain. It is
 * not implemented in this build: selecting it fails loudly instead of
 * pretending a step was executed.
 */
export class ForeignChainStepExecutor implements StepExecutor {
  async execute(step: SettlementStep, battle: BattleView): Promise<bigint> {
    throw new Error(
      `foreign-chain execution is not available in this build (battle ${battle.id}, step ${step.index})`,
    );
  }
}
