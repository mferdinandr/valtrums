import type { ArenaClient } from "./client.js";
import type { StepExecutor } from "./executor.js";
import { type Logger, errorMessage, silentLogger } from "./logger.js";
import type { TwapFetcher } from "./twap.js";

export type SettleOutcome = "settled" | "skipped";

/**
 * Submit final prices for a Live battle whose end time has passed. Re-reads the
 * battle first, so duplicates and stale work items are no-ops. Price failures
 * propagate before any transaction, leaving the battle Live for the next pass.
 */
export async function settleEnded(
  client: ArenaClient,
  fetcher: TwapFetcher,
  battleId: number,
  nowNs: bigint,
  log: Logger = silentLogger,
): Promise<SettleOutcome> {
  const battle = await client.getBattle(battleId);
  if (!battle || battle.status !== "Live") return "skipped";
  if (nowNs < BigInt(battle.end_time_ns)) return "skipped";
  const { priceA, priceB } = await fetcher.finalPrices(battle);
  try {
    await client.settleBattle(battleId, priceA, priceB);
  } catch (err) {
    // Lost a race with another submission: fine if the battle has moved on.
    const again = await client.getBattle(battleId);
    if (again && again.status !== "Live") {
      log.info("settle_battle rejected, battle already moved on", {
        battleId,
        status: again.status,
      });
      return "skipped";
    }
    throw err;
  }
  log.info("battle settling", { battleId, priceA, priceB });
  return "settled";
}

export interface DriveResult {
  reported: number[];
  skipped: number;
}

/**
 * Drive the pending steps of a Settling battle in index order. Work comes from
 * the on-chain plan only (`done` flags), so a restart or a duplicate pass picks
 * up exactly the steps that are still open. Stops at the first failing step
 * (steps may depend on earlier ones) and rethrows after logging.
 */
export async function driveSettlement(
  client: ArenaClient,
  executor: StepExecutor,
  battleId: number,
  log: Logger = silentLogger,
): Promise<DriveResult> {
  const result: DriveResult = { reported: [], skipped: 0 };
  const battle = await client.getBattle(battleId);
  if (!battle || battle.status !== "Settling") return result;
  const plan = [...(await client.getSettlementPlan(battleId))].sort((a, b) => a.index - b.index);

  for (const step of plan) {
    if (step.done) {
      result.skipped++;
      continue;
    }
    const realized = await executor.execute(step, battle);
    try {
      await client.reportExecution(battleId, step.index, realized);
    } catch (err) {
      // Idempotent on-chain: an "already done" rejection is fine if the plan agrees.
      const fresh = await client.getSettlementPlan(battleId);
      if (fresh.find((s) => s.index === step.index)?.done) {
        log.info("step already reported", { battleId, step: step.index });
        result.skipped++;
        continue;
      }
      log.error("report_execution failed", { battleId, step: step.index, error: errorMessage(err) });
      throw err;
    }
    log.info("step reported", { battleId, step: step.index, kind: step.kind, realized });
    result.reported.push(step.index);
  }
  return result;
}
