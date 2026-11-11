import type { NearTransport } from "../near-client.js";
import { errorMessage, silentLogger, type Logger } from "../logger.js";

/** `cancel_lifecycle_battle` only sets a flag and emits an event; no deposit is needed. */
export const CANCEL_GAS = "30 Tgas";
/** After a failed or unconfirmed attempt wait this long before sending the same battle again. */
export const CANCEL_RETRY_AFTER_MS = 30_000;
const MIN_FUNDED = 2;
const MAX_ERROR_CHARS = 300;

export type CancelOutcome =
  | { status: "cancelled" }
  | { status: "already_cancelled" }
  | { status: "not_applicable"; reason: string }
  | { status: "backoff" }
  | { status: "unconfirmed" }
  | { status: "failed"; error: string };

export interface CancelContext {
  /** Start time in ms; a battle without one can never be cancelled. */
  startAtMs: number | null;
  locked: boolean;
  cancelled: boolean;
  /** Number of communities with a deposit. */
  funded: number;
}

export interface LifecycleCancelDeps {
  contractId: string;
  transport: Pick<NearTransport, "call">;
  now: () => Date;
  /** Reads the on-chain `cancelled` flag; keeps the step idempotent and confirms the cancel landed. */
  isCancelled: (battleId: number) => Promise<boolean>;
  retryAfterMs?: number;
  gas?: string;
  log?: Logger;
}

/**
 * Optional cancel step (AUDIT_CANCEL_ENABLED=true). It sends `cancel_lifecycle_battle` when the
 * start time has passed, the battle is not locked and fewer than two communities are funded: the
 * same conditions the contract enforces, which stays the only authority (anyone may cancel, so
 * this step grants nothing). Idempotent and restart-safe: the chain is re-read before every send.
 * Refunds are pull-based and claimed by each depositor; this step never moves funds.
 */
export class LifecycleCanceller {
  private readonly cancelled = new Set<number>();
  private readonly retryAt = new Map<number, number>();
  private readonly log: Logger;

  constructor(private readonly deps: LifecycleCancelDeps) {
    this.log = deps.log ?? silentLogger;
  }

  async tryCancel(battleId: number, context: CancelContext): Promise<CancelOutcome> {
    if (this.cancelled.has(battleId) || context.cancelled) return { status: "already_cancelled" };
    if (context.locked) return { status: "not_applicable", reason: "locked" };
    if (context.startAtMs === null) return { status: "not_applicable", reason: "no_start_time" };
    if (this.deps.now().getTime() < context.startAtMs) return { status: "not_applicable", reason: "not_started" };
    if (context.funded >= MIN_FUNDED) return { status: "not_applicable", reason: "enough_funded" };
    const wait = this.retryAt.get(battleId);
    if (wait !== undefined && this.deps.now().getTime() < wait) return { status: "backoff" };
    try {
      if (await this.deps.isCancelled(battleId)) {
        this.cancelled.add(battleId);
        return { status: "already_cancelled" };
      }
      await this.deps.transport.call(this.deps.contractId, "cancel_lifecycle_battle", { battle_id: battleId }, this.deps.gas ?? CANCEL_GAS);
      if (await this.deps.isCancelled(battleId)) {
        this.cancelled.add(battleId);
        this.retryAt.delete(battleId);
        this.log.info("lifecycle battle cancelled", { battleId, funded: context.funded });
        return { status: "cancelled" };
      }
      this.backoff(battleId);
      this.log.warn("lifecycle cancel sent but not confirmed", { battleId });
      return { status: "unconfirmed" };
    } catch (err) {
      this.backoff(battleId);
      const error = errorMessage(err).slice(0, MAX_ERROR_CHARS);
      this.log.error("lifecycle cancel failed", { battleId, error });
      return { status: "failed", error };
    }
  }

  private backoff(battleId: number): void {
    this.retryAt.set(battleId, this.deps.now().getTime() + (this.deps.retryAfterMs ?? CANCEL_RETRY_AFTER_MS));
  }
}
