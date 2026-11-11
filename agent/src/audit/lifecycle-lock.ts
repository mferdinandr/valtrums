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
/** The contract locks only with at least this many funded communities. */
export const MIN_FUNDED_COMMUNITIES = 2;
const MAX_ERROR_CHARS = 300;

export type LockOutcome =
  | { status: "locked" }
  | { status: "already_locked" }
  | { status: "cancelled" }
  | { status: "not_started"; startAtMs: number }
  | { status: "not_ready"; reason: string }
  | { status: "backoff" }
  | { status: "unconfirmed" }
  | { status: "failed"; error: string };

/** What the pass read from the battle view. Everything is optional so a caller that knows nothing more gets the plain rule. */
export interface LockContext {
  /** Communities with a deposit. Zero-vault communities are excluded from the lock and need no fresh record. Default: all. */
  fundedIndices?: number[];
  /** Start time in ms; the lock waits until the agent's clock reaches it. Null or absent: no start time. */
  startAtMs?: number | null;
  /** A cancelled battle is never locked. */
  cancelled?: boolean;
  /** False when a funded community's backing approval is missing or about to lapse; the contract would refuse the lock. */
  backingReady?: boolean;
}

export interface LifecycleLockDeps {
  contractId: string;
  transport: Pick<NearTransport, "call">;
  /** The records map the refresh step writes; the lock re-checks every funded community against it. */
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
 * Sends `lock_lifecycle_battle` only when the start time (if any) has passed, at least two
 * communities are funded and every FUNDED community holds a passing record that still has at least
 * `minRemainingMs` of life; zero-vault communities are ignored. It passes `expected_communities`
 * (the total count) so the contract refuses the lock if a community was appended meanwhile. A
 * cancelled battle is never locked. The contract repeats every check against block time, so this
 * is a second line and never the only one. Idempotent: a locked battle is never called again, a
 * failure backs off, and a retry after an unknown outcome re-reads the chain first. Errors are
 * returned bounded, never thrown.
 */
export class LifecycleLocker {
  private readonly locked = new Set<number>();
  private readonly retryAt = new Map<number, number>();
  private readonly log: Logger;

  constructor(private readonly deps: LifecycleLockDeps) {
    this.log = deps.log ?? silentLogger;
  }

  /** `ready` is the refresh result for this battle's funded communities; `communities` is the total community count. */
  async tryLock(battleId: number, communities: number, ready: boolean, context: LockContext = {}): Promise<LockOutcome> {
    if (this.locked.has(battleId)) return { status: "already_locked" };
    if (context.cancelled) return { status: "cancelled" };
    if (!ready) return { status: "not_ready", reason: "refresh_not_ready" };
    if (context.startAtMs != null && this.deps.now().getTime() < context.startAtMs) {
      return { status: "not_started", startAtMs: context.startAtMs };
    }
    const all = Number.isInteger(communities) && communities > 0 ? Array.from({ length: communities }, (_, i) => i) : [];
    const funded = context.fundedIndices ?? all;
    if (funded.length === 0) return { status: "not_ready", reason: "no_communities" };
    if (funded.length < MIN_FUNDED_COMMUNITIES) return { status: "not_ready", reason: "too_few_funded" };
    const stale = this.firstStale(battleId, funded);
    if (stale) return { status: "not_ready", reason: stale };
    if (context.backingReady === false) return { status: "not_ready", reason: "backing_not_ready" };
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
        { battle_id: battleId, expected_communities: communities },
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

  /** Reason code of the first funded community without a passing record that still has enough life. */
  private firstStale(battleId: number, funded: number[]): string | undefined {
    const needed = this.deps.now().getTime() + (this.deps.minRemainingMs ?? DEFAULT_MIN_REMAINING_MS);
    for (const i of funded) {
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
