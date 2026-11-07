import type { NearTransport } from "../near-client.js";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import { refreshBattleAudit, type CommittedAsset, type RefreshDeps } from "./approval.js";
import type { LifecycleLocker } from "./lifecycle-lock.js";
import { AuditReportStore } from "./report.js";

/** Subset of the arena's `LifecycleView` this pass reads. */
export interface LifecycleBattleView {
  locked: boolean;
  communities: {
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

export interface LifecycleAuditPassDeps {
  source: LifecycleAuditSource;
  refresh: Omit<RefreshDeps, "isLocked">;
  reports?: AuditReportStore;
  /** Optional lock step (see lifecycle-lock.ts); runs only after a refresh that left every community ready. */
  lock?: Pick<LifecycleLocker, "tryLock">;
  log?: Logger;
}

/**
 * One scheduler step: refresh the audit of every unlocked lifecycle battle that is missing,
 * stale (within the refresh-ahead margin), changed or not passed. A failure in one battle is
 * logged and does not block the others. Locked battles are never touched.
 */
export function createLifecycleAuditPass(deps: LifecycleAuditPassDeps): () => Promise<{ checked: number; ready: number; errors: number }> {
  const log = deps.log ?? silentLogger;
  return async () => {
    let checked = 0;
    let ready = 0;
    let errors = 0;
    const total = await deps.source.count();
    for (let id = 1; id <= total; id++) {
      try {
        const view = await deps.source.get(id);
        if (!view || view.locked) continue;
        const result = await refreshBattleAudit(id, assetsOf(view), {
          ...deps.refresh,
          isLocked: async () => false,
        });
        for (const [key, record] of deps.refresh.records) {
          if (key.startsWith(`${id}:`)) deps.reports?.put(record);
        }
        checked++;
        if (result.ready) ready++;
        if (deps.lock && (await deps.lock.tryLock(id, view.communities.length, result.ready)).status === "failed") errors++;
      } catch (err) {
        errors++;
        log.error("lifecycle audit failed", { battleId: id, error: errorMessage(err) });
      }
    }
    return { checked, ready, errors };
  };
}
