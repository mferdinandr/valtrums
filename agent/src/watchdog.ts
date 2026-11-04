import type { LiquiditySource } from "./auditor.js";
import type { Baseline, BaselineStore } from "./baseline.js";
import type { ArenaClient } from "./client.js";
import { type Logger, errorMessage, silentLogger } from "./logger.js";
import type { BattleView } from "./types.js";

/** A drop strictly greater than this fraction of the baseline triggers a halt. */
export const HALT_DROP_FRACTION = 0.5;

export type WatchdogOutcome =
  | { action: "halted"; reason: string }
  | { action: "ok" }
  | { action: "skipped"; reason: string };

function percent(n: number): string {
  return `${n.toFixed(1)}%`;
}

/**
 * Check one battle's tokens against their audit-time liquidity.
 *
 * - Drop of more than 50% (strictly): emergency_halt naming token and numbers.
 *   Exactly 50% is not a halt.
 * - Data-source failure for a token: that token is skipped and nothing is
 *   halted on its account.
 * - Missing baseline (state lost): the current liquidity becomes the baseline
 *   and is logged. Known limitation: a drop that happened while no baseline
 *   existed is not detectable.
 */
export async function watchBattle(
  client: ArenaClient,
  liquidity: LiquiditySource,
  baselines: BaselineStore,
  battle: BattleView,
  log: Logger = silentLogger,
): Promise<WatchdogOutcome> {
  if (battle.status !== "Approved" && battle.status !== "Live") {
    return { action: "skipped", reason: `status is ${battle.status}` };
  }
  const known: Baseline = (await baselines.get(battle.id)) ?? {};
  const next: Baseline = { ...known };
  let changed = false;
  const breaches: string[] = [];

  for (const token of [battle.token_a, battle.token_b]) {
    let current: number;
    try {
      current = await liquidity.liquidityUsd(token);
    } catch (err) {
      log.warn("watchdog could not read liquidity, skipping token", {
        battleId: battle.id,
        token,
        error: errorMessage(err),
      });
      continue;
    }
    if (!Number.isFinite(current) || current < 0) continue;

    const base = known[token];
    if (base === undefined || !(base > 0)) {
      next[token] = current;
      changed = true;
      log.warn("baseline missing, using current liquidity", {
        battleId: battle.id,
        token,
        liquidityUsd: current,
      });
      continue;
    }
    // current < base * 0.5, written without float division so 50% is exact.
    if (current * 2 < base) {
      const drop = ((base - current) / base) * 100;
      breaches.push(
        `liquidity of ${token} dropped ${percent(drop)} (baseline $${base.toFixed(2)}, now $${current.toFixed(2)}), limit is ${percent(HALT_DROP_FRACTION * 100)}`,
      );
    }
  }

  if (changed) await baselines.set(battle.id, next);
  if (breaches.length === 0) return { action: "ok" };

  const reason = breaches.join("; ");
  try {
    await client.emergencyHalt(battle.id, reason);
  } catch (err) {
    const fresh = await client.getBattle(battle.id);
    if (fresh && fresh.status !== "Approved" && fresh.status !== "Live") {
      log.info("emergency_halt rejected, battle already moved on", {
        battleId: battle.id,
        status: fresh.status,
      });
      return { action: "skipped", reason: `status is ${fresh.status}` };
    }
    throw err;
  }
  log.warn("emergency halt", { battleId: battle.id, reason });
  return { action: "halted", reason };
}
