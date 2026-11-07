import type { NearTransport } from "../near-client.js";
import {
  evaluateCommunity,
  goplusTarget,
  policyHash,
  type AuditAsset,
  type AuditPolicy,
  type AuditRecord,
  type Reason,
} from "./decision.js";
import { resolveReference, type DeclaredReference, type ReferenceEntry } from "./reference.js";
import type { GoPlusQuery, RawGoPlusResponse } from "./goplus.js";
import type { LpEvidence } from "./liquidity.js";

export const sameAsset = (a: AuditAsset, b: AuditAsset): boolean =>
  a.chainId === b.chainId &&
  a.token.toLowerCase() === b.token.toLowerCase() &&
  a.representation === b.representation &&
  a.custodyDomain === b.custodyDomain &&
  a.mappingVersion === b.mappingVersion &&
  a.reference?.chainId === b.reference?.chainId &&
  a.reference?.token.toLowerCase() === b.reference?.token.toLowerCase() &&
  a.reference?.registryEntryHash === b.reference?.registryEntryHash;

export type RefreshReason =
  | "missing"
  | "not_passed"
  | "asset_changed"
  | "policy_changed"
  | "expired"
  | "no_expiry";

/** Whether a stored record still supports approval of `asset` under `policy` at `now`. */
export function approvalStatus(
  record: AuditRecord | undefined,
  asset: AuditAsset,
  policy: AuditPolicy,
  now: Date,
): { valid: true } | { valid: false; reason: RefreshReason } {
  if (!record) return { valid: false, reason: "missing" };
  if (!sameAsset(record.asset, asset)) return { valid: false, reason: "asset_changed" };
  if (record.policyHash !== policyHash(policy)) return { valid: false, reason: "policy_changed" };
  if (record.result !== "pass") return { valid: false, reason: "not_passed" };
  if (!record.expiresAt) return { valid: false, reason: "no_expiry" };
  if (now.getTime() >= Date.parse(record.expiresAt)) return { valid: false, reason: "expired" };
  return { valid: true };
}

export interface LockReadiness {
  ready: boolean;
  /** Communities that must be re-audited before lock can proceed. */
  needsRefresh: { index: number; reason: RefreshReason }[];
}

/** Lock is refused unless every community has a valid, unexpired pass bound to its current asset and policy. */
export function lockReadiness(
  assets: AuditAsset[],
  records: (AuditRecord | undefined)[],
  policy: AuditPolicy,
  now: Date,
): LockReadiness {
  const needsRefresh: LockReadiness["needsRefresh"] = [];
  assets.forEach((asset, index) => {
    const s = approvalStatus(records[index], asset, policy, now);
    if (!s.valid) needsRefresh.push({ index, reason: s.reason });
  });
  return { ready: needsRefresh.length === 0, needsRefresh };
}

/** Arguments of the arena's `submit_lifecycle_audit` method (u64 values are decimal strings). */
export function submitArgs(battleId: number, community: number, record: AuditRecord): object {
  return {
    battle_id: battleId,
    community,
    asset: {
      chain_id: record.asset.chainId,
      token_address: record.asset.token,
      representation: record.asset.representation,
      custody_domain: record.asset.custodyDomain,
      // Must equal the committed pair: the contract refuses an approval for a different pair.
      reference_chain_id: record.asset.reference?.chainId ?? null,
      reference_address: record.asset.reference?.token.toLowerCase() ?? null,
    },
    result: record.result,
    policy_hash: record.policyHash,
    evidence_hash: record.evidenceHash,
    // Required by the contract for a pass (block time in ms, at most 24 h ahead); ignored otherwise.
    // The contract refuses a pass whose expiry is missing or not in the future.
    expires_at_ms: record.result === "pass" && record.expiresAt ? String(Date.parse(record.expiresAt)) : null,
  };
}

const SUBMIT_GAS = "30 Tgas";
/** Covers storage growth for one approval; the contract refunds the unused part. */
const SUBMIT_DEPOSIT = "0.01 NEAR";

/** Sends audit outcomes to the arena. Repeating an identical outcome is a no-op. */
export class AuditSubmitter {
  private readonly sent = new Map<string, string>();
  constructor(
    private readonly contractId: string,
    private readonly transport: Pick<NearTransport, "call">,
  ) {}

  async submit(battleId: number, community: number, record: AuditRecord): Promise<boolean> {
    const key = `${battleId}:${community}`;
    const fingerprint = `${record.result}:${record.evidenceHash}:${record.policyHash}`;
    if (this.sent.get(key) === fingerprint) return false;
    await this.transport.call(
      this.contractId,
      "submit_lifecycle_audit",
      submitArgs(battleId, community, record),
      SUBMIT_GAS,
      SUBMIT_DEPOSIT,
    );
    this.sent.set(key, fingerprint);
    return true;
  }
}

/** Base asset as read from the arena, with the reference pair committed on-chain (null = none committed). */
export type CommittedAsset = AuditAsset & { committed?: DeclaredReference | null };

export interface RefreshDeps {
  policy: AuditPolicy;
  /** Protocol-controlled reference-token registry; the only accepted source of reference mappings. */
  registry: readonly ReferenceEntry[];
  /** Mapping a token declares about itself (untrusted); optional. */
  declaredReference?: (asset: AuditAsset) => DeclaredReference | null;
  now: () => Date;
  /** Re-audit when less than this much approval life remains (default 0). */
  refreshAheadMs?: number;
  fetchGoPlus: (q: GoPlusQuery) => Promise<RawGoPlusResponse>;
  fetchLp: (asset: AuditAsset) => Promise<LpEvidence | null>;
  submitter: Pick<AuditSubmitter, "submit">;
  records: Map<string, AuditRecord>;
  /** True once the battle snapshot froze; audits are then never refreshed or submitted. */
  isLocked: (battleId: number) => Promise<boolean>;
}

/**
 * Re-audits only communities whose approval is missing, expired, changed or not passed, and
 * submits each result. Re-running with nothing stale performs no provider calls or writes.
 * Reference mappings are resolved from the registry on every pass, so a registry change
 * invalidates the affected approval.
 */
export async function refreshBattleAudit(
  battleId: number,
  baseAssets: CommittedAsset[],
  deps: RefreshDeps,
): Promise<LockReadiness & { skippedBecauseLocked: boolean }> {
  if (await deps.isLocked(battleId)) {
    return { ready: true, needsRefresh: [], skippedBecauseLocked: true };
  }
  const key = (i: number) => `${battleId}:${i}`;
  const resolved = baseAssets.map((withCommit): { asset: AuditAsset; hold?: Reason } => {
    const { committed, ...base } = withCommit;
    // The pair committed on-chain is what is audited; the registry decides if it is acceptable.
    const declared = committed !== undefined ? committed : (deps.declaredReference?.(base) ?? null);
    const r = resolveReference(base, deps.registry, declared);
    if (r.kind === "mapped" && committed === null) {
      return {
        asset: { ...base, reference: undefined },
        hold: {
          code: "reference_mismatch",
          message: "registry maps this token to a reference but the committed community mapping has none",
        },
      };
    }
    if (r.kind === "mapped") return { asset: { ...base, reference: r.reference } };
    if (r.kind === "hold") {
      // Keep the committed pair on the record (marked unverified) so the pending result still
      // names the community's real asset when it is submitted.
      const reference = committed
        ? {
            chainId: committed.referenceChainId,
            token: committed.referenceAddress.toLowerCase(),
            registryEntryHash: "unverified",
          }
        : undefined;
      return { asset: { ...base, reference }, hold: { code: r.code, message: r.message } };
    }
    return { asset: { ...base, reference: undefined } };
  });
  const assets = resolved.map((r) => r.asset);
  // Refresh ahead of expiry so an approval cannot lapse between two scheduler passes.
  const before = lockReadiness(
    assets,
    assets.map((_, i) => deps.records.get(key(i))),
    deps.policy,
    new Date(deps.now().getTime() + (deps.refreshAheadMs ?? 0)),
  );
  for (const { index } of before.needsRefresh) {
    const { asset, hold } = resolved[index]!;
    const target = goplusTarget(asset);
    const record = evaluateCommunity({
      asset,
      goplus: hold ? null : await deps.fetchGoPlus(target),
      lp: await deps.fetchLp(asset),
      policy: deps.policy,
      now: deps.now(),
      ...(hold ? { referenceHold: hold } : {}),
    });
    deps.records.set(key(index), record);
    await deps.submitter.submit(battleId, index, record);
  }
  const after = lockReadiness(
    assets,
    assets.map((_, i) => deps.records.get(key(i))),
    deps.policy,
    deps.now(),
  );
  return { ...after, skippedBecauseLocked: false };
}
