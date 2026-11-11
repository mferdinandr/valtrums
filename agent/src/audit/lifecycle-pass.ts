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
  return async () => {
    let checked = 0;
    let ready = 0;
    let errors = 0;
    const registry = (await deps.refresh.registry.load()).entries;
    const total = await deps.source.count();
    for (let id = 1; id <= total; id++) {
      try {
        const view = await deps.source.get(id);
        if (!view || view.locked || view.cancelled) continue;
        const result = await refreshBattleAudit(id, assetsOf(view), {
          ...deps.refresh,
          registry,
          isLocked: async () => false,
        });
        // Attribution is bounded to the current view's communities and their trusted indices.
        for (let i = 0; i < view.communities.length; i++) {
          const record = deps.refresh.records.get(`${id}:${i}`);
          if (!record) continue;
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
          const backed = await deps.backing.refresh(id, (i) => deps.refresh.records.get(`${id}:${i}`)?.result === "pass");
          errors += backed.failed.length;
          backingReady = funded.every((i) => backed.ready.has(i));
        }
        const fundedReady = result.needsRefresh.every((n) => !fundedSet.has(n.index));
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
