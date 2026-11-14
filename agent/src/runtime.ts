import { type LiquiditySource, type MarketAuditor, auditAndAct } from "./auditor.js";
import type { BaselineStore } from "./baseline.js";
import { type ArenaClient, fetchAllBattles } from "./client.js";
import type { StepExecutor } from "./executor.js";
import type { OnChainStepExecutor } from "./onchain-executor.js";
import type { ExecutionMode } from "./runtime-config.js";
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
  /** Selected with EXECUTION_MODE=onchain; replaces `executor` for settlement steps. */
  onChainExecutor?: OnChainStepExecutor;
  /**
   * Configured execution mode. When set, each pass checks it against the arena's
   * `execution_dex` and skips settlement work on a mismatch.
   */
  executionMode?: ExecutionMode;
  /**
   * Optional lifecycle audit refresh (GoPlus + LP) run every pass before locks and settlement,
   * so approvals are renewed ahead of their TTL. Errors it reports count toward `errors`.
   */
  lifecycleAudit?: () => Promise<{ errors: number }>;
  /** Optional prize settlement of finished lifecycle battles (open to any caller); runs after the audit each pass. */
  lifecycleSettle?: () => Promise<{ errors: number }>;
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
  stepsDispatched: number;
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
    stepsDispatched: 0,
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

  const mismatch = deps.executionMode ? await checkExecutionMode(deps.client, deps.executionMode) : null;
  if (mismatch) {
    report.errors++;
    log.error(`${mismatch}; settlement is paused, other work continues`);
  }

  if (deps.lifecycleAudit) {
    const audit = deps.lifecycleAudit;
    await guard("lifecycle audit", {}, async () => {
      report.errors += (await audit()).errors;
    });
  }

  if (deps.lifecycleSettle) {
    const settle = deps.lifecycleSettle;
    await guard("lifecycle settle", {}, async () => {
      report.errors += (await settle()).errors;
    });
  }

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
        if (mismatch) break;
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
    if (b.status !== "Settling" || mismatch) continue;
    await guard("settlement steps", { battleId: b.id }, async () => {
      if (deps.onChainExecutor) {
        const res = await deps.onChainExecutor.advance(b.id);
        report.stepsReported += res.booked.length;
        report.stepsDispatched += res.dispatched.length;
        return;
      }
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

/**
 * Compare the configured execution mode with the arena: on-chain execution
 * needs `execution_dex` set, mock and foreign execution need it unset (the
 * contract refuses `report_execution` otherwise), and foreign execution also
 * needs the arena's foreign signing configuration. Returns an error text, or null if fine.
 */
export async function checkExecutionMode(
  client: ArenaClient,
  mode: ExecutionMode,
): Promise<string | null> {
  const dex = (await client.getConfig()).execution_dex;
  if (mode === "onchain" && !dex) {
    return "EXECUTION_MODE=onchain but the arena has no execution_dex";
  }
  if ((mode === "mock" || mode === "foreign") && dex) {
    return `EXECUTION_MODE=${mode} but the arena executes on-chain via ${dex}`;
  }
  if (mode === "foreign" && !(await client.getForeignConfig())) {
    return "EXECUTION_MODE=foreign but the arena has no foreign signing configuration (set_foreign)";
  }
  return null;
}
