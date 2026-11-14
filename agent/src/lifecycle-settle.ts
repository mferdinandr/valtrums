import type { NearTransport } from "./near-client.js";
import { errorMessage, silentLogger, type Logger } from "./logger.js";

/** The arena forwards one entitlement per backing contract call; the web uses the same budget. */
export const SETTLE_GAS = "300 Tgas";
/** Arena ENTITLEMENT_DEPOSIT per recorded prize (10 mNEAR); the arena refunds what a batch does not use. */
export const ENTITLEMENT_DEPOSIT_YOCTO = 10_000_000_000_000_000_000_000n;
/** Contract bound on `max_entitlements` of `settle_lifecycle_battle`. */
export const MAX_SETTLE_BATCH = 15;
/** Only the newest battles are visited each pass; older ones were settled long ago. */
export const DEFAULT_RECENT_BATTLES = 10;
/** Stop after this many batches per battle in one pass; the next pass continues. */
export const DEFAULT_MAX_BATCHES = 10;
/** After a batch that did not advance the cursor, wait this long before trying the same battle again. */
export const SETTLE_RETRY_AFTER_MS = 60_000;
export const DEFAULT_CONFIRM = { tries: 10, delayMs: 800 } as const;
const MAX_ERROR_CHARS = 300;

interface SettlementProgress {
  recorded: number;
  total: number;
}

export interface LifecycleSettleDeps {
  contractId: string;
  transport: Pick<NearTransport, "view" | "call">;
  now: () => Date;
  recentBattles?: number;
  maxBatches?: number;
  retryAfterMs?: number;
  /** Views read at `final` can trail the batch by a few blocks: re-read this many times, this far apart. */
  confirm?: { tries: number; delayMs: number };
  /** Waits between confirmation reads; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
}

export interface SettlePassResult {
  /** Prizes recorded by this pass. */
  settled: number;
  errors: number;
}

/**
 * Records the prizes of every finished battle as soon as the arena allows it, so the winners see every coin they won
 * without sending the settlement batches themselves. `settle_lifecycle_battle` is open to any caller and the arena
 * works the split out from the frozen snapshot, so this step has no say over who gets what. The agent only pays the
 * storage deposit per recorded prize. A battle without a settlement plan yet (no winner) reads as null and is revisited.
 * A fully settled battle is remembered and never read again. Errors are returned bounded, never thrown.
 */
export class LifecycleSettler {
  private readonly done = new Set<number>();
  private readonly retryAt = new Map<number, number>();
  private readonly log: Logger;

  constructor(private readonly deps: LifecycleSettleDeps) {
    this.log = deps.log ?? silentLogger;
  }

  async pass(): Promise<SettlePassResult> {
    const result: SettlePassResult = { settled: 0, errors: 0 };
    const count = Number(await this.deps.transport.view<number | string>(this.deps.contractId, "get_lifecycle_battle_count", {}));
    if (!Number.isSafeInteger(count) || count < 1) return result;
    const first = Math.max(1, count - (this.deps.recentBattles ?? DEFAULT_RECENT_BATTLES) + 1);
    for (let id = count; id >= first; id--) {
      if (this.done.has(id)) continue;
      if ((this.retryAt.get(id) ?? 0) > this.deps.now().getTime()) continue;
      try {
        const settled = await this.settleBattle(id);
        result.settled += settled;
      } catch (err) {
        result.errors++;
        this.retryAt.set(id, this.deps.now().getTime() + (this.deps.retryAfterMs ?? SETTLE_RETRY_AFTER_MS));
        this.log.error("lifecycle settle failed", { battleId: id, error: errorMessage(err).slice(0, MAX_ERROR_CHARS) });
      }
    }
    return result;
  }

  private async progress(id: number): Promise<SettlementProgress | null> {
    const v = await this.deps.transport.view<{ recorded?: number; total?: number } | null>(this.deps.contractId, "get_settlement_progress", {
      battle_id: String(id),
    });
    return v && Number.isInteger(v.recorded) && Number.isInteger(v.total) ? { recorded: v.recorded as number, total: v.total as number } : null;
  }

  private async settleBattle(id: number): Promise<number> {
    let recordedHere = 0;
    for (let batchNo = 0; batchNo < (this.deps.maxBatches ?? DEFAULT_MAX_BATCHES); batchNo++) {
      const before = await this.progress(id);
      if (before === null) return recordedHere;
      if (before.recorded >= before.total) {
        this.done.add(id);
        return recordedHere;
      }
      const batch = Math.min(MAX_SETTLE_BATCH, before.total - before.recorded);
      this.log.info("lifecycle settle batch", { battleId: id, recorded: before.recorded, total: before.total, batch });
      await this.deps.transport.call(
        this.deps.contractId,
        "settle_lifecycle_battle",
        { battle_id: String(id), max_entitlements: batch },
        SETTLE_GAS,
        `${ENTITLEMENT_DEPOSIT_YOCTO * BigInt(batch)} yocto`,
      );
      const after = await this.confirmed(id, before.recorded);
      if (after === null) throw new Error(`settlement did not advance past ${before.recorded} of ${before.total}`);
      recordedHere += after.recorded - before.recorded;
      if (after.recorded >= after.total) {
        this.done.add(id);
        this.log.info("lifecycle settle complete", { battleId: id, total: after.total });
        return recordedHere;
      }
    }
    return recordedHere;
  }

  /** Reads progress until it moves past `recorded`; null when it never does within the confirmation window. */
  private async confirmed(id: number, recorded: number): Promise<SettlementProgress | null> {
    const { tries, delayMs } = this.deps.confirm ?? DEFAULT_CONFIRM;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; i < tries; i++) {
      const p = await this.progress(id);
      if (p !== null && p.recorded > recorded) return p;
      if (i < tries - 1) await sleep(delayMs);
    }
    return null;
  }
}
