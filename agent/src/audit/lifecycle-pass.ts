import type { NearTransport } from "../near-client.js";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import type { ReferenceRegistrySource } from "../reference-registry.js";
import { refreshBattleAudit, type CommittedAsset, type RefreshDeps } from "./approval.js";
import type { BackingRefresher } from "./backing-refresh.js";
import type { LifecycleCanceller } from "./lifecycle-cancel.js";
import type { LifecycleLocker } from "./lifecycle-lock.js";
import type { ArchiveProvenance, ReportArchive } from "./report-archive.js";
import { summarizeReasons } from "./reason-summary.js";
import { AuditReportStore, buildAuditReport } from "./report.js";

/** Subset of the arena's `LifecycleView` this pass reads. */
export interface LifecycleBattleView {
  locked: boolean;
  /** Start time in ms (decimal string); null or absent for a battle created without one. */
  start_at_ms?: string | null;
  /** True after `cancel_lifecycle_battle`; a cancelled battle is never audited, backed or locked. */
  cancelled?: boolean;
  communities: {
    /** Vault amount (decimal string). A community with a zero vault is pending: audited and backed, but not funded. Absent on an older view: treated as funded. */
    vault?: string;
    chain_id: string | number;
    token_address: string;
    representation: string;
    custody_domain: string;
    /** Optional committed mainnet reference pair (both set or both absent). */
    reference_chain_id?: string | number | null;
    reference_address?: string | null;
  }[];
}

export interface LifecycleAuditSource {
  count(): Promise<number>;
  get(id: number): Promise<LifecycleBattleView | null>;
}

/** The contract locks only with at least this many funded communities. */
const MIN_FUNDED = 2;

/** An unlocked battle that is due to start is revisited at most this often within one sweep. */
const LOCK_REVISIT_MS = 3_000;
/** After a backing refresh is sent, the battle is looked at again after this long to confirm it. */
const BACKING_RECHECK_MS = 4_000;

/** The lifecycle asset identity has no separate version field; this label names that shape (v2 adds the optional reference pair). */
export const ASSET_MAPPING_VERSION = "asset-identity-v2";

export class NearLifecycleAuditSource implements LifecycleAuditSource {
  constructor(
    private readonly contractId: string,
    private readonly transport: Pick<NearTransport, "view">,
  ) {}
  async count(): Promise<number> {
    return Number(await this.transport.view<number | string>(this.contractId, "get_lifecycle_battle_count", {}));
  }
  async get(id: number): Promise<LifecycleBattleView | null> {
    return (
      (await this.transport.view<LifecycleBattleView | null>(this.contractId, "get_lifecycle_battle", {
        battle_id: id,
      })) ?? null
    );
  }
}

/** Indices of the communities with a deposit. A community without a `vault` field (older view) counts as funded. */
export function fundedIndices(view: LifecycleBattleView): number[] {
  const out: number[] = [];
  view.communities.forEach((c, i) => {
    if (c.vault === undefined || (/^[0-9]+$/.test(c.vault) && BigInt(c.vault) > 0n)) out.push(i);
  });
  return out;
}

export function assetsOf(view: LifecycleBattleView): CommittedAsset[] {
  return view.communities.map((c) => ({
    chainId: String(c.chain_id),
    token: c.token_address,
    representation: c.representation,
    custodyDomain: c.custody_domain,
    mappingVersion: ASSET_MAPPING_VERSION,
    committed:
      c.reference_chain_id != null && c.reference_address != null
        ? { referenceChainId: String(c.reference_chain_id), referenceAddress: c.reference_address }
        : null,
  }));
}

/** Durable report sink; only `put` is used so the lifecycle pass cannot read or mutate history. */
export type ReportArchiveSink = Pick<ReportArchive, "put">;

export interface LifecycleAuditPassDeps {
  source: LifecycleAuditSource;
  /**
   * `registry` is the on-chain reference registry, loaded once per pass; a failed or inconsistent
   * read fails the whole pass closed, so nothing is audited against a partial registry.
   */
  refresh: Omit<RefreshDeps, "isLocked" | "registry"> & { registry: ReferenceRegistrySource };
  reports?: AuditReportStore;
  /** Optional durable archive sink for report history; `arena` is required when it is set. */
  archive?: ReportArchiveSink;
  /** Trusted arena/domain label stored with every archived observation. Never derived from a key string. */
  arena?: string;
  /** Provenance recorded for archived observations (default "recorded"). */
  provenance?: ArchiveProvenance;
  /** Optional lock step (see lifecycle-lock.ts); runs only after a refresh that left every community ready. */
  lock?: Pick<LifecycleLocker, "tryLock">;
  /** Optional backing step: keeps every community's backing approval fresh (see backing-refresh.ts). */
  backing?: Pick<BackingRefresher, "refresh">;
  /** Optional cancel step (AUDIT_CANCEL_ENABLED): cancels a battle whose start passed with fewer than two funded communities. */
  cancel?: Pick<LifecycleCanceller, "tryCancel">;
  /**
   * Written by every sweep: the earliest future start time (ms) among unlocked battles with at least two funded
   * communities, or null. The agent loop sleeps until then so the lock goes out at the start time, not up to a
   * whole interval later.
   */
  wake?: { nextStartMs: number | null; /** Battles starting at `nextStartMs`; the next pass handles them first. */ imminent?: number[] };
  log?: Logger;
}

/**
 * One scheduler step: refresh the audit of every unlocked lifecycle battle that is missing,
 * stale (within the refresh-ahead margin), changed or not passed. A failure in one battle is
 * logged and does not block the others. Locked battles are never touched.
 *
 * When an archive sink is injected, each community's current report is persisted with trusted
 * arena/battle/community attribution (the community index comes from the current view, never from
 * splitting a record key), and a bounded structured summary is logged. A sink failure is surfaced
 * as an error and logged, isolates the other battles, and never changes policy evaluation, the
 * `ready` count or on-chain submission. Re-archiving unchanged decision content for the same evidence
 * is idempotent when only the decision clock advances. Fresh provider queries/LP observations change
 * the evidence hash and create new history, even for unchanged findings; the archive capacity is
 * finite. A failed archive can be retried on the next pass without a provider call when evidence is
 * still fresh. Archiving does not change provider cadence or submission behavior.
 */
export function createLifecycleAuditPass(deps: LifecycleAuditPassDeps): () => Promise<{ checked: number; ready: number; errors: number }> {
  const log = deps.log ?? silentLogger;
  if (deps.archive && (deps.arena === undefined || deps.arena.length === 0)) {
    throw new Error("lifecycle audit archive requires a non-empty arena label for attribution");
  }
  const provenance: ArchiveProvenance = deps.provenance ?? "recorded";
  // Survives across passes: whether a battle's funded communities were all audit-ready at its last visit.
  const lastFundedReady = new Map<number, boolean>();
  return async () => {
    let checked = 0;
    let ready = 0;
    let errors = 0;
    const registry = (await deps.refresh.registry.load()).entries;
    let total = await deps.source.count();
    // Newly joined communities must not wait behind a cold audit of every old arena.
    // Order: (1) battles with a community that has no audit record yet (a fresh battle or a token
    // that just joined an older one), newest first; (2) everything else, newest first, so existing
    // funded battles still get renewed. Views are read once up front and reused below.
    const views = new Map<number, LifecycleBattleView | null>();
    const hasUnaudited = (id: number, v: LifecycleBattleView | null | undefined): boolean =>
      !!v && !v.locked && !v.cancelled && v.communities.some((_, i) => !deps.refresh.records.has(`${id}:${i}`));
    const hot: number[] = [];
    const rest: number[] = [];
    const discoveryStarted = Date.now();
    // Fast path: the loop woke for a battle start, so those battles go first and the discovery of every other
    // battle is skipped for this one pass (the next pass rediscovers). The lock then goes out right away
    // instead of after reading all the old battles. A stale hint (start long past) is ignored.
    const wakeNow = deps.refresh.now().getTime();
    const fast =
      deps.wake && deps.wake.nextStartMs !== null && deps.wake.nextStartMs <= wakeNow + 1_000 && deps.wake.nextStartMs >= wakeNow - 10_000 && (deps.wake.imminent?.length ?? 0) > 0
        ? [...deps.wake.imminent!].sort((a, b) => b - a)
        : null;
    if (fast && deps.wake) {
      hot.push(...fast);
      for (let id = total; id >= 1; id--) if (!fast.includes(id)) rest.push(id);
      deps.wake.imminent = [];
      deps.wake.nextStartMs = null;
      log.info("lifecycle audit fast path: starting battles first", { battles: fast });
    }
    // Bound read concurrency; signatures and approval submissions below remain sequential.
    for (let newest = fast ? 0 : total; newest >= 1; newest -= 3) {
      const ids = Array.from({ length: Math.min(3, newest) }, (_, i) => newest - i);
      const results = await Promise.allSettled(ids.map((id) => deps.source.get(id)));
      for (const [i, result] of results.entries()) {
        const id = ids[i]!;
        if (result.status === "fulfilled") {
          const v = result.value;
          views.set(id, v);
          (hasUnaudited(id, v) ? hot : rest).push(id);
        } else rest.push(id); // retried and reported by the audit loop
      }
    }
    if (deps.wake && !fast) {
      const nowMs = deps.refresh.now().getTime();
      let next: number | null = null;
      let imminent: number[] = [];
      for (const [id, v] of views) {
        if (!v || v.locked || v.cancelled || !v.start_at_ms || fundedIndices(v).length < MIN_FUNDED) continue;
        const startMs = Number(v.start_at_ms);
        if (!Number.isFinite(startMs) || startMs <= nowMs) continue;
        if (next === null || startMs < next) {
          next = startMs;
          imminent = [id];
        } else if (startMs === next) imminent.push(id);
      }
      deps.wake.nextStartMs = next;
      deps.wake.imminent = imminent;
    }
    // A battle whose start has come must not wait behind the renewal of an idle one: every other battle yields
    // (stops before its next provider call or transaction) once that start time passes. The pass then returns
    // at once and the next one takes the fast path above.
    const startingIds = new Set<number>(fast ?? deps.wake?.imminent ?? []);
    const dueStart = fast ? null : (deps.wake?.nextStartMs ?? null);
    const yieldFor = (id: number): boolean => dueStart !== null && !startingIds.has(id) && deps.refresh.now().getTime() >= dueStart;
    log.info("lifecycle audit discovery complete", { battles: total, priorityBattles: hot.length, durationMs: Date.now() - discoveryStarted });
    const queue = [...hot, ...rest];
    // Unlocked, uncancelled battles can still receive a joining token, so they are re-checked
    // between steps instead of only once per sweep (locked and cancelled ones never change back).
    const open = new Set<number>();
    const attempted = new Map<number, number>();
    const hotSet = new Set(hot);
    const visitedAt = new Map<number, number>();
    const recheckAt = new Map<number, number>();
    let forced = false;
    for (const [id, v] of views) if (v && !v.locked && !v.cancelled) open.add(id);
    for (let pos = 0; pos < queue.length; pos++) {
      const id = queue[pos]!;
      if (yieldFor(id)) {
        log.info("lifecycle audit yielding to a starting battle", { next: id });
        return { checked, ready, errors };
      }
      try {
        // A token that joined an already-visited (or later-queued) open battle jumps the queue.
        let jumped = false;
        // The battle that just jumped is processed first; scanning again would let two new ones bounce forever.
        const scan = forced ? [] : [...open].sort((a, b) => b - a);
        forced = false;
        for (const openId of scan) {
          if (openId === id) continue;
          const v = await deps.source.get(openId);
          if (!v || v.locked || v.cancelled) {
            open.delete(openId);
            continue;
          }
          // A battle whose start has come (or has no start), with two funded communities, still unlocked:
          // its lock waits on backing or audit transactions sent in an earlier visit, so look again soon
          // instead of after the whole sweep.
          const nowMs = deps.refresh.now().getTime();
          const startMs = v.start_at_ms ? Number(v.start_at_ms) : null;
          const due = recheckAt.get(openId);
          if (due !== undefined && nowMs >= due) {
            recheckAt.delete(openId);
            const later = queue.indexOf(openId, pos + 1);
            if (later >= 0) queue.splice(later, 1);
            queue.splice(pos, 0, openId);
            jumped = true;
            forced = true;
            break;
          }
          const lockDue =
            fundedIndices(v).length >= 2 &&
            // Only worth revisiting while the audits are not the blocker; a battle whose funded
            // community stays pending would otherwise be re-audited every few seconds.
            (lastFundedReady.get(openId) ?? true) &&
            (startMs === null || startMs <= nowMs) &&
            nowMs - (visitedAt.get(openId) ?? 0) >= LOCK_REVISIT_MS;
          if (lockDue) {
            const later = queue.indexOf(openId, pos + 1);
            if (later >= 0) queue.splice(later, 1);
            queue.splice(pos, 0, openId);
            jumped = true;
            forced = true;
            break;
          }
          if (!hasUnaudited(openId, v)) continue;
          // A failed audit leaves no record; only jump again when a new community has appeared since the attempt.
          if ((attempted.get(openId) ?? 0) >= v.communities.length) continue;
          // Hot battles not visited yet are already ordered by the queue; jumping them would ping-pong.
          if (hotSet.has(openId) && !attempted.has(openId)) continue;
          const later = queue.indexOf(openId, pos + 1);
          if (later >= 0) queue.splice(later, 1);
          queue.splice(pos, 0, openId);
          jumped = true;
          forced = true;
          break;
        }
        if (jumped) {
          pos--;
          continue;
        }
        // A battle created or joined while this sweep runs jumps the queue instead of waiting for the next pass.
        const latest = await deps.source.count();
        if (latest > total) {
          const fresh: number[] = [];
          for (let n = latest; n > total; n--) fresh.push(n);
          total = latest;
          // The current id is re-queued right after the fresh ones.
          queue.splice(pos, 1, ...fresh, id);
          pos--;
          continue;
        }
        // Always read fresh: the up-front view may predate a join that happened while earlier battles ran.
        const view = await deps.source.get(id);
        if (!view || view.locked || view.cancelled) {
          open.delete(id);
          continue;
        }
        // Start has passed with fewer than two funded communities: the battle can never lock, so
        // auditing and backing it again is wasted provider time. Only the cancel step still applies.
        const deadStart = view.start_at_ms ? Number(view.start_at_ms) : null;
        if (deadStart !== null && deadStart <= deps.refresh.now().getTime() && fundedIndices(view).length < MIN_FUNDED) {
          open.delete(id);
          if (deps.cancel) {
            const outcome = await deps.cancel.tryCancel(id, {
              startAtMs: deadStart,
              locked: false,
              cancelled: false,
              funded: fundedIndices(view).length,
            });
            if (outcome.status === "failed") errors++;
          }
          continue;
        }
        open.add(id);
        attempted.set(id, view.communities.length);
        visitedAt.set(id, deps.refresh.now().getTime());
        log.info("lifecycle audit checking battle", { battleId: id, communities: view.communities.length });
        const auditStarted = Date.now();
        const result = await refreshBattleAudit(id, assetsOf(view), {
          ...deps.refresh,
          log,
          registry,
          isLocked: async () => false,
          shouldYield: () => yieldFor(id),
        });
        log.info("lifecycle audit evaluation complete", { battleId: id, durationMs: Date.now() - auditStarted, ready: result.ready });
        // Attribution is bounded to the current view's communities and their trusted indices.
        for (let i = 0; i < view.communities.length; i++) {
          const record = deps.refresh.records.get(`${id}:${i}`);
          if (!record) continue;
          log.info("lifecycle audit community evaluated", { battleId: id, community: i, result: record.result });
          const report = deps.reports ? deps.reports.put(record) : undefined;
          if (!deps.archive) continue;
          const built = report ?? buildAuditReport(record);
          try {
            const put = await deps.archive.put({
              report: built,
              attribution: { arena: deps.arena!, battleId: id, community: i },
              provenance,
            });
            const reasonSummary = summarizeReasons(built.reasons);
            log.info("audit report archived", {
              arena: deps.arena,
              battleId: id,
              community: i,
              evidenceHash: built.evidenceHash,
              policyVersion: built.policy.version,
              policyHash: built.policy.hash,
              result: built.result,
              auditKind: built.auditKind,
              referenceToken: built.reference?.token ?? null,
              assetToken: built.asset.token,
              custodyDomain: built.asset.custodyDomain,
              expiresAt: built.times.expiresAt,
              reasonCodes: reasonSummary.reasons.map((r) => r.code),
              reasons: reasonSummary.reasons,
              reasonsTruncated: reasonSummary.truncated,
              unknownReasonCodes: reasonSummary.reasons.filter((r) => !r.known).map((r) => r.code),
              observationId: put.observation.observationId,
              archived: put.created,
            });
          } catch (err) {
            errors++;
            log.error("audit report archive failed", {
              battleId: id,
              community: i,
              evidenceHash: built.evidenceHash,
              error: errorMessage(err),
            });
          }
        }
        checked++;
        if (result.ready) ready++;
        // Every community (funded or not) is audited and backed so a deposit can open it; the lock and
        // the cancel decision look only at the funded ones.
        const funded = fundedIndices(view);
        const fundedSet = new Set(funded);
        let backingReady: boolean | undefined;
        if (deps.backing) {
          const backingStarted = Date.now();
          const backed = await deps.backing.refresh(id, (i) => deps.refresh.records.get(`${id}:${i}`)?.result === "pass", () => yieldFor(id));
          log.info("lifecycle backing refresh complete", { battleId: id, ready: [...backed.ready], failed: backed.failed.length, durationMs: Date.now() - backingStarted });
          errors += backed.failed.length;
          // The refresh just sent is not yet confirmed (ready was read before sending). Look again in a few
          // seconds so a deposit is not rejected with backing_missing until the next full sweep.
          if (backed.sent.length > 0) recheckAt.set(id, deps.refresh.now().getTime() + BACKING_RECHECK_MS);
          backingReady = funded.every((i) => backed.ready.has(i));
        }
        const fundedReady = result.needsRefresh.every((n) => !fundedSet.has(n.index));
        lastFundedReady.set(id, fundedReady);
        const startAtMs = view.start_at_ms ? Number(view.start_at_ms) : null;
        let lockStatus: string | undefined;
        if (deps.lock) {
          const outcome = await deps.lock.tryLock(id, view.communities.length, fundedReady, {
            fundedIndices: funded,
            startAtMs,
            cancelled: false,
            ...(backingReady !== undefined ? { backingReady } : {}),
          });
          lockStatus = outcome.status;
          if (outcome.status === "failed") errors++;
        }
        if (deps.cancel && lockStatus !== "locked" && lockStatus !== "failed") {
          const outcome = await deps.cancel.tryCancel(id, { startAtMs, locked: false, cancelled: false, funded: funded.length });
          if (outcome.status === "failed") errors++;
        }
      } catch (err) {
        errors++;
        log.error("lifecycle audit failed", { battleId: id, error: errorMessage(err) });
      }
    }
    return { checked, ready, errors };
  };
}
