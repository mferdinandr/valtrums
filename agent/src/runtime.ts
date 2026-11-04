import { type LiquiditySource, type MarketAuditor, auditAndAct } from "./auditor.js";
import type { BaselineStore } from "./baseline.js";
import { type ArenaClient, fetchAllBattles } from "./client.js";
import type { StepExecutor } from "./executor.js";
import { type Logger, errorMessage, silentLogger } from "./logger.js";
import { planWork } from "./planner.js";
import { driveSettlement, settleEnded } from "./settlement.js";
import { type TwapFetcher, lockWithInitialPrices } from "./twap.js";
import { watchBattle } from "./watchdog.js";

/** Records one price observation per token, so TWAP history accrues. */
export interface PriceSampler {
  sampleOnce(token: string): Promise<unknown>;
}

export interface RuntimeDeps {
  client: ArenaClient;
  auditor: MarketAuditor;
  baselines: BaselineStore;
  twap: TwapFetcher;
  sampler: PriceSampler;
  liquidity: LiquiditySource;
  executor: StepExecutor;
  log?: Logger;
  /** Wall clock in ms; injectable for tests. */
  nowMs?: () => number;
  /** Run the liquidity watchdog in this pass (the loop enables it hourly). */
  watchdog?: boolean;
}

export interface PassReport {
  audited: number;
  locked: number;
  settled: number;
  stepsReported: number;
  watched: number;
  halted: number;
  errors: number;
}

/**
 * One full pass: sample prices, then planner -> auditor -> price lock ->
 * settlement -> watchdog. All decisions come from on-chain state read during
 * the pass; nothing is carried between passes except the baseline store. A
 * failure in one battle is logged and does not block the others.
 */
export async function runOnce(deps: RuntimeDeps): Promise<PassReport> {
  const log = deps.log ?? silentLogger;
  const nowMs = deps.nowMs ?? Date.now;
  const nowNs = BigInt(nowMs()) * 1_000_000n;
  const report: PassReport = {
    audited: 0,
    locked: 0,
    settled: 0,
    stepsReported: 0,
    watched: 0,
    halted: 0,
    errors: 0,
  };
  const guard = async (what: string, fields: Record<string, unknown>, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      report.errors++;
      log.error(`${what} failed`, { ...fields, error: errorMessage(err) });
    }
  };

  const before = await fetchAllBattles(deps.client);

  const tokens = new Set<string>();
  for (const b of before) {
    if (b.status === "Approved" || b.status === "Live") {
      tokens.add(b.token_a);
      tokens.add(b.token_b);
    }
  }
  for (const token of tokens) {
    await guard("price sample", { token }, async () => void (await deps.sampler.sampleOnce(token)));
  }

  for (const item of planWork(before, nowNs)) {
    const fields = { battleId: item.battleId };
    switch (item.kind) {
      case "audit":
        await guard("audit", fields, async () => {
          const out = await auditAndAct(deps.client, deps.auditor, item.battleId, deps.baselines);
          if (out.action !== "skipped") {
            report.audited++;
            log.info(`battle ${out.action}`, { ...fields, reason: out.result.reason || undefined });
          }
        });
        break;
      case "set_initial_prices":
        await guard("price lock", fields, async () => {
          if ((await lockWithInitialPrices(deps.client, deps.twap, item.battleId, nowNs)) === "locked") {
            report.locked++;
            log.info("battle locked with initial prices", fields);
          }
        });
        break;
      case "settle":
        await guard("settle", fields, async () => {
          if ((await settleEnded(deps.client, deps.twap, item.battleId, nowNs, log)) === "settled") {
            report.settled++;
          }
        });
        break;
    }
  }

  // Re-read: statuses changed above (e.g. a battle just moved to Settling or Live).
  const after = await fetchAllBattles(deps.client);

  for (const b of after) {
    if (b.status !== "Settling") continue;
    await guard("settlement steps", { battleId: b.id }, async () => {
      const res = await driveSettlement(deps.client, deps.executor, b.id, log);
      report.stepsReported += res.reported.length;
    });
  }

  if (deps.watchdog) {
    for (const b of after) {
      if (b.status !== "Approved" && b.status !== "Live") continue;
      await guard("watchdog", { battleId: b.id }, async () => {
        const out = await watchBattle(deps.client, deps.liquidity, deps.baselines, b, log);
        report.watched++;
        if (out.action === "halted") report.halted++;
      });
    }
  }

  return report;
}
