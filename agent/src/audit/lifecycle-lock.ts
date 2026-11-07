import type { NearTransport } from "../near-client.js";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import type { AuditRecord } from "./decision.js";

/** The lock freezes a snapshot, so it is not a cheap call; unused gas is refunded. */
export const LOCK_GAS = "100 Tgas";
/**
 * Covers the snapshot's storage growth (the contract needs at least 1 yoctoNEAR and charges the
 * actual storage cost) and refunds the rest. The key must come from the environment, never the repo.
 */
export const LOCK_DEPOSIT = "0.1 NEAR";
/** Keep this much approval life at send time so an approval cannot lapse while the transaction is in flight. */
export const DEFAULT_MIN_REMAINING_MS = 60_000;
/** After a failed attempt wait this long before sending the same battle again. */
export const DEFAULT_RETRY_AFTER_MS = 30_000;
const MAX_ERROR_CHARS = 300;

export type LockOutcome =
  | { status: "locked" }
  | { status: "already_locked" }
  | { status: "not_ready"; reason: string }
  | { status: "backoff" }
  | { status: "unconfirmed" }
  | { status: "failed"; error: string };

export interface LifecycleLockDeps {
  contractId: string;
  transport: Pick<NearTransport, "call">;
  /** The records map the refresh step writes; the lock re-checks every community against it. */
  records: ReadonlyMap<string, AuditRecord>;
  now: () => Date;
  /** Reads the on-chain `locked` flag; used to stay idempotent and to confirm the lock landed. */
  isLocked: (battleId: number) => Promise<boolean>;
  minRemainingMs?: number;
  retryAfterMs?: number;
  deposit?: string;
  gas?: string;
  log?: Logger;
}

/**
 * Sends `lock_lifecycle_battle` only when every community holds a passing record that still has at
 * least `minRemainingMs` of life. The contract repeats the check against block time and refuses an
 * expired, missing or changed approval, so this is a second line and never the only one.
 * Idempotent: a locked battle is never called again, a failure backs off, and a retry after an
 * unknown outcome re-reads the chain first. Errors are returned bounded, never thrown.
 */
export class LifecycleLocker {
  private readonly locked = new Set<number>();
  private readonly retryAt = new Map<number, number>();
  private readonly log: Logger;

  constructor(private readonly deps: LifecycleLockDeps) {
    this.log = deps.log ?? silentLogger;
  }

  /** `ready` is the refresh result for this battle; `communities` is its community count. */
  async tryLock(battleId: number, communities: number, ready: boolean): Promise<LockOutcome> {
    if (this.locked.has(battleId)) return { status: "already_locked" };
    if (!ready) return { status: "not_ready", reason: "refresh_not_ready" };
    const stale = this.firstStale(battleId, communities);
    if (stale) return { status: "not_ready", reason: stale };
    const wait = this.retryAt.get(battleId);
    if (wait !== undefined && this.deps.now().getTime() < wait) return { status: "backoff" };
    try {
      if (await this.deps.isLocked(battleId)) {
        this.locked.add(battleId);
        return { status: "already_locked" };
      }
      await this.deps.transport.call(
        this.deps.contractId,
        "lock_lifecycle_battle",
        { battle_id: battleId },
        this.deps.gas ?? LOCK_GAS,
        this.deps.deposit ?? LOCK_DEPOSIT,
      );
      if (await this.deps.isLocked(battleId)) {
        this.locked.add(battleId);
        this.retryAt.delete(battleId);
        this.log.info("lifecycle battle locked", { battleId });
        return { status: "locked" };
      }
      this.backoff(battleId);
      this.log.warn("lifecycle lock sent but not confirmed", { battleId });
      return { status: "unconfirmed" };
    } catch (err) {
      this.backoff(battleId);
      const error = errorMessage(err).slice(0, MAX_ERROR_CHARS);
      this.log.error("lifecycle lock failed", { battleId, error });
      return { status: "failed", error };
    }
  }

  private backoff(battleId: number): void {
    this.retryAt.set(battleId, this.deps.now().getTime() + (this.deps.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS));
  }

  /** Reason code of the first community without a passing record that still has enough life. */
  private firstStale(battleId: number, communities: number): string | undefined {
    if (!Number.isInteger(communities) || communities < 1) return "no_communities";
    const needed = this.deps.now().getTime() + (this.deps.minRemainingMs ?? DEFAULT_MIN_REMAINING_MS);
    for (let i = 0; i < communities; i++) {
      const record = this.deps.records.get(`${battleId}:${i}`);
      if (!record) return `community_${i}_missing`;
      if (record.result !== "pass") return `community_${i}_not_passed`;
      const expires = record.expiresAt ? Date.parse(record.expiresAt) : Number.NaN;
      if (!Number.isFinite(expires)) return `community_${i}_no_expiry`;
      if (expires <= needed) return `community_${i}_expiring`;
    }
    return undefined;
  }
}
