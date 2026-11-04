import type { ArenaClient } from "./client.js";
import { type Logger, errorMessage, silentLogger } from "./logger.js";
import { type QuoteSource, minOutFromQuote } from "./quote.js";
import type { BattleView, ConfigView, SettlementStep } from "./types.js";

export interface OnChainExecutorOptions {
  /** Slippage tolerance in basis points applied to the DEX quote. */
  slippageBps?: number;
  /** A step dispatched for longer than this is reported as stuck. */
  stepTimeoutMs?: number;
  log?: Logger;
  /** Wall clock in ms; injectable for tests. */
  nowMs?: () => number;
}

export interface AdvanceResult {
  /** Steps sent to the DEX in this pass. */
  dispatched: number[];
  /** Return / zero-amount steps booked immediately by the contract. */
  booked: number[];
  /** The dispatched step the battle is waiting on, if any. */
  waitingOn: number | null;
  /** True when the pass stopped because no safe quote could be produced. */
  quoteFailed: boolean;
}

/**
 * Drives a Settling battle through the contract's on-chain execution. Each pass
 * looks at the plan only: the first not-done step is dispatched with a `min_out`
 * unless it already is dispatched, in which case the pass just waits (and flags
 * it when it takes too long). It never reports amounts. All state lives in the
 * plan's `done`/`dispatched` flags, so a restart makes the same decisions; the
 * only in-memory data is when a dispatch was first seen, used for the timeout.
 */
export class OnChainStepExecutor {
  private readonly slippageBps: number;
  private readonly stepTimeoutMs: number;
  private readonly log: Logger;
  private readonly nowMs: () => number;
  private readonly firstSeen = new Map<string, number>();
  private readonly lastAlert = new Map<string, number>();

  constructor(
    private readonly client: ArenaClient,
    private readonly quotes: QuoteSource,
    opts: OnChainExecutorOptions = {},
  ) {
    this.slippageBps = opts.slippageBps ?? 500;
    this.stepTimeoutMs = opts.stepTimeoutMs ?? 600_000;
    this.log = opts.log ?? silentLogger;
    this.nowMs = opts.nowMs ?? Date.now;
    // Fail on a bad tolerance at construction, not on the first dispatch.
    minOutFromQuote(1n, this.slippageBps);
  }

  async advance(battleId: number): Promise<AdvanceResult> {
    const result: AdvanceResult = { dispatched: [], booked: [], waitingOn: null, quoteFailed: false };
    const battle = await this.client.getBattle(battleId);
    if (!battle || battle.status !== "Settling") return result;
    const config = await this.client.getConfig();
    const plan = [...(await this.client.getSettlementPlan(battleId))].sort(
      (a, b) => a.index - b.index,
    );

    for (const step of plan) {
      if (step.done) continue;
      if (step.dispatched) {
        result.waitingOn = step.index;
        this.checkStuck(battleId, step);
        return result;
      }
      const immediate = step.kind === "Return" || BigInt(step.amount) === 0n;
      let minOut = 0n;
      if (!immediate) {
        const computed = await this.computeMinOut(step, battle, config);
        if (computed === null) {
          result.quoteFailed = true;
          return result;
        }
        minOut = computed;
      }
      try {
        await this.client.executeStep(battleId, step.index, minOut);
      } catch (err) {
        // A concurrent pass may have dispatched or booked it already: fine if the plan agrees.
        const fresh = (await this.client.getSettlementPlan(battleId)).find((s) => s.index === step.index);
        if (fresh && (fresh.done || fresh.dispatched)) {
          this.log.info("execute_step rejected, step already moved on", {
            battleId,
            step: step.index,
          });
          result.waitingOn = fresh.done ? null : step.index;
          if (fresh.done) continue;
          return result;
        }
        this.log.error("execute_step failed", {
          battleId,
          step: step.index,
          error: errorMessage(err),
        });
        throw err;
      }
      if (immediate) {
        this.log.info("step booked", { battleId, step: step.index, kind: step.kind });
        result.booked.push(step.index);
        continue;
      }
      this.firstSeen.set(key(battleId, step.index), this.nowMs());
      this.log.info("step dispatched", {
        battleId,
        step: step.index,
        kind: step.kind,
        amount: step.amount,
        minOut,
      });
      result.dispatched.push(step.index);
      result.waitingOn = step.index;
      return result;
    }
    return result;
  }

  /** `min_out` for a swap step, or null (logged) when no safe quote exists. */
  private async computeMinOut(
    step: SettlementStep,
    battle: BattleView,
    config: ConfigView,
  ): Promise<bigint | null> {
    const fields = { battleId: battle.id, step: step.index, kind: step.kind };
    const dex = config.execution_dex;
    if (!dex) {
      this.log.error("on-chain execution is off, cannot compute min_out", fields);
      return null;
    }
    if (battle.winner === null) {
      this.log.error("battle has no winner, cannot pick swap tokens", fields);
      return null;
    }
    const winnerCoin = battle.winner === "A" ? battle.token_a : battle.token_b;
    const loserCoin = battle.winner === "A" ? battle.token_b : battle.token_a;
    const [tokenIn, tokenOut] =
      step.kind === "Dump" ? [loserCoin, config.usdc] : [config.usdc, winnerCoin];
    try {
      const quote = await this.quotes.expectedOut(dex, tokenIn, tokenOut, BigInt(step.amount));
      if (quote <= 0n) {
        this.log.warn("quote is zero, not dispatching, will retry", { ...fields, tokenIn, tokenOut });
        return null;
      }
      return minOutFromQuote(quote, this.slippageBps);
    } catch (err) {
      this.log.warn("quote unavailable, not dispatching, will retry", {
        ...fields,
        tokenIn,
        tokenOut,
        error: errorMessage(err),
      });
      return null;
    }
  }

  private checkStuck(battleId: number, step: SettlementStep): void {
    const k = key(battleId, step.index);
    const now = this.nowMs();
    const since = this.firstSeen.get(k) ?? now;
    this.firstSeen.set(k, since);
    const elapsed = now - since;
    if (elapsed < this.stepTimeoutMs) return;
    // Repeat the alert at most once per timeout period.
    const last = this.lastAlert.get(k);
    if (last !== undefined && now - last < this.stepTimeoutMs) return;
    this.lastAlert.set(k, now);
    this.log.error("STUCK STEP: dispatched step has no proceeds, manual attention needed", {
      battleId,
      step: step.index,
      kind: step.kind,
      dispatchedForSecs: Math.floor(elapsed / 1000),
      timeoutSecs: Math.floor(this.stepTimeoutMs / 1000),
    });
  }
}

const key = (battleId: number, step: number) => `${battleId}:${step}`;
