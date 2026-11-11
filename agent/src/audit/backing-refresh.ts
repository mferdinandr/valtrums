import type { NearTransport } from "../near-client.js";
import { errorMessage, silentLogger, type Logger } from "../logger.js";

/**
 * `refresh_lifecycle_backing` asks the community's representation contract for its asset and ledger
 * and records the backing approval. The arena calls two views and a callback, so give it room.
 */
export const BACKING_REFRESH_GAS = "100 Tgas";
/** Pays the approval's storage (the contract needs at least 1 yocto); the unused part is refunded to the caller. */
export const BACKING_REFRESH_DEPOSIT = "0.01 NEAR";
/** Contract `BACKING_APPROVAL_MS`: a backing approval lives 10 minutes. */
export const BACKING_APPROVAL_MS = 600_000;
/** Refresh while at least this much life is left so an approval never lapses between two passes. */
export const DEFAULT_BACKING_REFRESH_AHEAD_MS = 180_000;
/** An approval must have at least this much life for the agent to count it as ready for a lock. */
export const DEFAULT_BACKING_MIN_REMAINING_MS = 60_000;
/** After sending a refresh wait this long before sending it again for the same community. */
export const DEFAULT_BACKING_RETRY_AFTER_MS = 30_000;
const MAX_ERROR_CHARS = 300;

/** One community's row of the arena's `get_lifecycle_readiness_v1` backing list. */
export interface BackingStatus {
  community: number;
  /** The representation is on the owner's trust list; an untrusted one cannot be backed. */
  trusted: boolean;
  assetMatches: boolean;
  fresh: boolean;
  expiresAtMs: number | null;
}

export interface BackingStatusSource {
  statuses(battleId: number): Promise<BackingStatus[]>;
}

export class NearBackingStatusSource implements BackingStatusSource {
  constructor(
    private readonly contractId: string,
    private readonly transport: Pick<NearTransport, "view">,
  ) {}

  async statuses(battleId: number): Promise<BackingStatus[]> {
    const raw = await this.transport.view<{
      backings?: { community: number; trusted: boolean; asset_matches: boolean; expires_at_ms: string | number | null; fresh: boolean }[] | null;
    }>(this.contractId, "get_lifecycle_readiness_v1", { battle_id: String(battleId) });
    return (raw?.backings ?? []).map((b) => ({
      community: b.community,
      trusted: b.trusted,
      assetMatches: b.asset_matches,
      fresh: b.fresh,
      expiresAtMs: b.expires_at_ms === null || b.expires_at_ms === undefined ? null : Number(b.expires_at_ms),
    }));
  }
}

export interface BackingRefreshDeps {
  contractId: string;
  transport: Pick<NearTransport, "call">;
  source: BackingStatusSource;
  now: () => Date;
  refreshAheadMs?: number;
  minRemainingMs?: number;
  retryAfterMs?: number;
  gas?: string;
  deposit?: string;
  log?: Logger;
}

export interface BackingRefreshResult {
  /** Communities a refresh transaction was sent for in this call. */
  sent: number[];
  /** Communities whose refresh could not be sent (error or untrusted representation). */
  failed: number[];
  /** Communities whose current approval has enough life left for a lock right now (read before sending). */
  ready: Set<number>;
}

/**
 * Keeps the backing approval of every community fresh by calling `refresh_lifecycle_backing`; the
 * agent account is the whitelisted caller. Nothing else calls it. Deposits into a community need
 * only that community's approval, so zero-vault communities are refreshed too. A community whose
 * audit does not pass is skipped through `wanted`. Idempotent: it reads the arena first, sends
 * only for a missing, withdrawn or soon-expiring approval, and waits `retryAfterMs` before
 * repeating a send. The contract withdraws the approval on a suspended or mismatched backing, so
 * a refresh that finds a problem simply leaves the community not ready.
 */
export class BackingRefresher {
  private readonly retryAt = new Map<string, number>();
  private readonly log: Logger;

  constructor(private readonly deps: BackingRefreshDeps) {
    this.log = deps.log ?? silentLogger;
  }

  async refresh(
    battleId: number,
    wanted: (community: number) => boolean = () => true,
    /** Checked before each transaction; true stops sending (the next visit continues). */
    shouldYield: () => boolean = () => false,
  ): Promise<BackingRefreshResult> {
    const result: BackingRefreshResult = { sent: [], failed: [], ready: new Set() };
    const nowMs = this.deps.now().getTime();
    const ahead = this.deps.refreshAheadMs ?? DEFAULT_BACKING_REFRESH_AHEAD_MS;
    const minRemaining = this.deps.minRemainingMs ?? DEFAULT_BACKING_MIN_REMAINING_MS;
    for (const status of await this.deps.source.statuses(battleId)) {
      const remaining = status.expiresAtMs === null ? 0 : status.expiresAtMs - nowMs;
      if (status.trusted && status.assetMatches && status.fresh && remaining >= minRemaining) result.ready.add(status.community);
      if (!wanted(status.community)) continue;
      const lapsing = !status.fresh || !status.assetMatches || remaining < ahead;
      if (!lapsing) continue;
      if (!status.trusted) {
        result.failed.push(status.community);
        this.log.warn("backing refresh skipped: representation is not trusted", { battleId, community: status.community });
        continue;
      }
      if (shouldYield()) break;
      const key = `${battleId}:${status.community}`;
      const wait = this.retryAt.get(key);
      if (wait !== undefined && nowMs < wait) continue;
      this.retryAt.set(key, nowMs + (this.deps.retryAfterMs ?? DEFAULT_BACKING_RETRY_AFTER_MS));
      try {
        await this.deps.transport.call(
          this.deps.contractId,
          "refresh_lifecycle_backing",
          { battle_id: battleId, community: status.community },
          this.deps.gas ?? BACKING_REFRESH_GAS,
          this.deps.deposit ?? BACKING_REFRESH_DEPOSIT,
        );
        result.sent.push(status.community);
      } catch (err) {
        result.failed.push(status.community);
        this.log.error("backing refresh failed", { battleId, community: status.community, error: errorMessage(err).slice(0, MAX_ERROR_CHARS) });
      }
    }
    return result;
  }
}
